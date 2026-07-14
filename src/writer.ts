//
// writer.ts — readstat_writer_t core (port of readstat_writer.c)
//

import { ReadStatType, ReadStatCompress, ReadStatMeasure, ReadStatAlignment, readstatTypeClass, ReadStatTypeClass } from "./types.js";
import { ReadStatError } from "./errors.js";
import { Variable } from "./variable.js";
import { LabelSet, ValueLabel } from "./labelset.js";
import { Codec, defaultCodec } from "./codec.js";

export const READSTAT_PRODUCT_NAME = "ReadStat";
export const READSTAT_PRODUCT_URL = "https://github.com/WizardMac/ReadStat";

/** A string reference (Stata strL). */
export interface StringRef {
  firstV: number;
  firstO: number;
  len: number; // byte length including trailing NUL
  data: Uint8Array; // string bytes + NUL
}

export function stringRefInit(str: string): StringRef {
  const encoded = new TextEncoder().encode(str);
  const data = new Uint8Array(encoded.length + 1);
  data.set(encoded, 0);
  data[encoded.length] = 0;
  return { firstV: -1, firstO: -1, len: data.length, data };
}

function compareStringRefs(a: StringRef, b: StringRef): number {
  if (a.firstO === b.firstO) return a.firstV - b.firstV;
  return a.firstO - b.firstO;
}

export type DataWriter = (data: Uint8Array) => number;

export interface WriterModuleCallbacks {
  variableWidth?: (type: ReadStatType, userWidth: number) => number;
  variableOk?: (variable: Variable) => ReadStatError;
  writeInt8?: (writer: Writer, offset: number, variable: Variable, value: number) => ReadStatError;
  writeInt16?: (writer: Writer, offset: number, variable: Variable, value: number) => ReadStatError;
  writeInt32?: (writer: Writer, offset: number, variable: Variable, value: number) => ReadStatError;
  writeFloat?: (writer: Writer, offset: number, variable: Variable, value: number) => ReadStatError;
  writeDouble?: (writer: Writer, offset: number, variable: Variable, value: number) => ReadStatError;
  writeString?: (writer: Writer, offset: number, variable: Variable, value: string) => ReadStatError;
  writeStringRef?: (writer: Writer, offset: number, variable: Variable, ref: StringRef) => ReadStatError;
  writeMissingString?: (writer: Writer, offset: number, variable: Variable) => ReadStatError;
  writeMissingNumber?: (writer: Writer, offset: number, variable: Variable) => ReadStatError;
  writeMissingTagged?: (writer: Writer, offset: number, variable: Variable, tag: string) => ReadStatError;
  beginData?: (writer: Writer) => ReadStatError;
  writeRow?: (writer: Writer, rowData: Uint8Array, rowLen: number) => ReadStatError;
  endData?: (writer: Writer) => ReadStatError;
  moduleCtxFree?: (ctx: unknown) => void;
  metadataOk?: (writer: Writer) => ReadStatError;
}

export class Writer {
  dataWriter: DataWriter | null = null;
  bytesWritten = 0;
  version = 0;
  is64bit = 1;
  compression: ReadStatCompress = ReadStatCompress.NONE;
  /** file timestamp — seconds since Unix epoch */
  timestamp: number;

  variables: Variable[] = [];
  labelSets: LabelSet[] = [];
  notes: string[] = [];
  stringRefs: StringRef[] = [];

  row: Uint8Array = new Uint8Array(0);
  rowLen = 0;

  rowCount = 0;
  currentRow = 0;
  fileLabel = "";
  tableName = "";
  fweightVariable: Variable | null = null;

  callbacks: WriterModuleCallbacks = {};
  errorHandler: ((message: string) => void) | null = null;

  moduleCtx: unknown = null;
  userCtx: unknown = null;
  initialized = false;

  codec: Codec = defaultCodec;
  /** Encoding the module wants output strings converted into. */
  outputEncoding = "UTF-8";

  constructor() {
    this.timestamp = Math.floor(Date.now() / 1000);
    this.callbacks.writeRow = (writer, rowData, len) => writer.writeBytes(rowData.subarray(0, len));
  }

  setDataWriter(dataWriter: DataWriter): ReadStatError {
    this.dataWriter = dataWriter;
    return ReadStatError.OK;
  }

  // ---- byte-level output helpers ----

  writeBytes(bytes: Uint8Array): ReadStatError {
    const written = this.dataWriter!(bytes);
    if (written < bytes.length) return ReadStatError.ERROR_WRITE;
    this.bytesWritten += written;
    return ReadStatError.OK;
  }

  writeBytesAsLines(bytes: Uint8Array, lineLen: number, lineSep: string): ReadStatError {
    const sep = latin1Bytes(lineSep);
    const lineSepLen = sep.length;
    const len = bytes.length;
    let bytesWritten = 0;
    let retval = ReadStatError.OK;
    while (bytesWritten < len) {
      const bytesLeftInLine = lineLen - (this.bytesWritten % (lineLen + lineSepLen));
      if (len - bytesWritten < bytesLeftInLine) {
        retval = this.writeBytes(bytes.subarray(bytesWritten, len));
        bytesWritten = len;
      } else {
        retval = this.writeBytes(bytes.subarray(bytesWritten, bytesWritten + bytesLeftInLine));
        bytesWritten += bytesLeftInLine;
      }
      if (retval !== ReadStatError.OK) break;
      if (this.bytesWritten % (lineLen + lineSepLen) === lineLen) {
        if ((retval = this.writeBytes(sep)) !== ReadStatError.OK) break;
      }
    }
    return retval;
  }

  writeLinePadding(pad: number, lineLen: number, lineSep: string): ReadStatError {
    const sep = latin1Bytes(lineSep);
    const lineSepLen = sep.length;
    if (this.bytesWritten % (lineLen + lineSepLen) === 0) return ReadStatError.OK;
    const bytesLeftInLine = lineLen - (this.bytesWritten % (lineLen + lineSepLen));
    const bytes = new Uint8Array(bytesLeftInLine).fill(pad & 0xff);
    let error = this.writeBytes(bytes);
    if (error !== ReadStatError.OK) return ReadStatError.OK; // C returns OK regardless
    this.writeBytes(sep);
    return ReadStatError.OK;
  }

  private writeRepeatedByte(byte: number, len: number): ReadStatError {
    if (len === 0) return ReadStatError.OK;
    return this.writeBytes(new Uint8Array(len).fill(byte & 0xff));
  }
  writeZeros(len: number): ReadStatError {
    return this.writeRepeatedByte(0, len);
  }
  writeSpaces(len: number): ReadStatError {
    return this.writeRepeatedByte(0x20, len);
  }
  /** Write a string as raw bytes (ASCII/latin1 semantics; matches strlen). */
  writeString(str: string): ReadStatError {
    return this.writeBytes(latin1Bytes(str));
  }
  writeSpacePaddedString(str: string | null, maxLen: number): ReadStatError {
    if (str === null || str.length === 0) return this.writeSpaces(maxLen);
    const bytes = latin1Bytes(str);
    let len = bytes.length;
    if (len > maxLen) len = maxLen;
    const retval = this.writeBytes(bytes.subarray(0, len));
    if (retval !== ReadStatError.OK) return retval;
    return this.writeSpaces(maxLen - len);
  }

  // ---- label sets ----

  addLabelSet(type: ReadStatType, name: string): LabelSet {
    const ls = new LabelSet(type, name.slice(0, 255));
    this.labelSets.push(ls);
    return ls;
  }
  getLabelSet(index: number): LabelSet | null {
    return index < this.labelSets.length ? this.labelSets[index] : null;
  }
  getValueLabel(labelSet: LabelSet, index: number): ValueLabel | null {
    return index < labelSet.valueLabels.length ? labelSet.valueLabels[index] : null;
  }
  sortLabelSet(labelSet: LabelSet, compare: (a: ValueLabel, b: ValueLabel) => number): void {
    labelSet.valueLabels.sort(compare);
  }

  // ---- variables ----

  addVariable(name: string | null, type: ReadStatType, width: number): Variable {
    const v = new Variable(type, this.variables.length);
    v.userWidth = width;
    if (readstatTypeClass(type) === ReadStatTypeClass.STRING) {
      v.alignment = ReadStatAlignment.LEFT;
    } else {
      v.alignment = ReadStatAlignment.RIGHT;
    }
    v.measure = ReadStatMeasure.UNKNOWN;
    if (name) v.name = name.slice(0, 299);
    this.variables.push(v);
    return v;
  }
  getVariable(index: number): Variable | null {
    return index < this.variables.length ? this.variables[index] : null;
  }
  setVariableLabelSet(variable: Variable, labelSet: LabelSet | null): void {
    variable.labelSet = labelSet;
    if (labelSet) labelSet.variables.push(variable);
  }

  // ---- string refs ----

  addStringRef(str: string): StringRef {
    const ref = stringRefInit(str);
    this.stringRefs.push(ref);
    return ref;
  }
  getStringRef(index: number): StringRef | null {
    return index < this.stringRefs.length ? this.stringRefs[index] : null;
  }

  // ---- notes ----

  addNote(note: string): void {
    this.notes.push(note);
  }

  // ---- optional metadata setters ----

  setFileLabel(label: string): ReadStatError {
    this.fileLabel = label.slice(0, 256);
    return ReadStatError.OK;
  }
  setFileTimestamp(timestamp: number): ReadStatError {
    this.timestamp = timestamp;
    return ReadStatError.OK;
  }
  setTableName(name: string): ReadStatError {
    this.tableName = name.slice(0, 32);
    return ReadStatError.OK;
  }
  setFweightVariable(variable: Variable): ReadStatError {
    if (variable.getTypeClass() === ReadStatTypeClass.STRING) return ReadStatError.ERROR_BAD_FREQUENCY_WEIGHT;
    this.fweightVariable = variable;
    return ReadStatError.OK;
  }
  setFileFormatVersion(version: number): ReadStatError {
    this.version = version;
    return ReadStatError.OK;
  }
  setFileFormatIs64bit(is64bit: number): ReadStatError {
    this.is64bit = is64bit;
    return ReadStatError.OK;
  }
  setCompression(compression: ReadStatCompress): ReadStatError {
    this.compression = compression;
    return ReadStatError.OK;
  }
  setErrorHandler(handler: (message: string) => void): ReadStatError {
    this.errorHandler = handler;
    return ReadStatError.OK;
  }

  // ---- validation ----

  validateVariable(variable: Variable): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (this.callbacks.variableOk) return this.callbacks.variableOk(variable);
    return ReadStatError.OK;
  }
  validateMetadata(): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (this.callbacks.metadataOk) return this.callbacks.metadataOk(this);
    return ReadStatError.OK;
  }

  private beginWritingData(): ReadStatError {
    let retval = this.validateMetadata();
    if (retval !== ReadStatError.OK) return retval;

    let rowLen = 0;
    for (let i = 0; i < this.variables.length; i++) {
      const variable = this.variables[i];
      variable.storageWidth = this.callbacks.variableWidth!(variable.type, variable.userWidth);
      variable.offset = rowLen;
      rowLen += variable.storageWidth;
    }
    if (this.callbacks.variableOk) {
      for (let i = 0; i < this.variables.length; i++) {
        retval = this.validateVariable(this.variables[i]);
        if (retval !== ReadStatError.OK) return retval;
      }
    }
    this.rowLen = rowLen;
    this.row = new Uint8Array(rowLen);
    if (this.callbacks.beginData) {
      retval = this.callbacks.beginData(this);
    }
    return retval;
  }

  beginWritingFile(userCtx: unknown, rowCount: number): ReadStatError {
    this.rowCount = rowCount;
    this.userCtx = userCtx;
    this.initialized = true;
    return this.validateMetadata();
  }

  beginRow(): ReadStatError {
    let retval = ReadStatError.OK;
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (this.currentRow === 0) retval = this.beginWritingData();
    this.row.fill(0);
    return retval;
  }

  insertInt8Value(variable: Variable, value: number): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.INT8) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    return this.callbacks.writeInt8!(this, variable.offset, variable, value);
  }
  insertInt16Value(variable: Variable, value: number): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.INT16) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    return this.callbacks.writeInt16!(this, variable.offset, variable, value);
  }
  insertInt32Value(variable: Variable, value: number): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.INT32) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    return this.callbacks.writeInt32!(this, variable.offset, variable, value);
  }
  insertFloatValue(variable: Variable, value: number): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.FLOAT) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    return this.callbacks.writeFloat!(this, variable.offset, variable, value);
  }
  insertDoubleValue(variable: Variable, value: number): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.DOUBLE) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    return this.callbacks.writeDouble!(this, variable.offset, variable, value);
  }
  insertStringValue(variable: Variable, value: string): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.STRING) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    return this.callbacks.writeString!(this, variable.offset, variable, value);
  }
  insertStringRef(variable: Variable, ref: StringRef | null): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type !== ReadStatType.STRING_REF) return ReadStatError.ERROR_VALUE_TYPE_MISMATCH;
    if (!this.callbacks.writeStringRef) return ReadStatError.ERROR_STRING_REFS_NOT_SUPPORTED;
    if (ref && ref.firstO === -1 && ref.firstV === -1) {
      ref.firstO = this.currentRow + 1;
      ref.firstV = variable.index + 1;
    }
    return this.callbacks.writeStringRef(this, variable.offset, variable, ref!);
  }
  insertMissingValue(variable: Variable): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (variable.type === ReadStatType.STRING) {
      return this.callbacks.writeMissingString!(this, variable.offset, variable);
    }
    if (variable.type === ReadStatType.STRING_REF) {
      return this.insertStringRef(variable, null);
    }
    return this.callbacks.writeMissingNumber!(this, variable.offset, variable);
  }
  insertTaggedMissingValue(variable: Variable, tag: string): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (!this.callbacks.writeMissingTagged) {
      this.callbacks.writeMissingNumber!(this, variable.offset, variable);
      return ReadStatError.ERROR_TAGGED_VALUES_NOT_SUPPORTED;
    }
    return this.callbacks.writeMissingTagged(this, variable.offset, variable, tag);
  }

  endRow(): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    const error = this.callbacks.writeRow!(this, this.row, this.rowLen);
    if (error === ReadStatError.OK) this.currentRow++;
    return error;
  }

  endWriting(): ReadStatError {
    if (!this.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
    if (this.currentRow !== this.rowCount) return ReadStatError.ERROR_ROW_COUNT_MISMATCH;
    if (this.rowCount === 0) {
      const retval = this.beginWritingData();
      if (retval !== ReadStatError.OK) return retval;
    }
    for (let i = 1; i < this.stringRefs.length; i++) {
      if (compareStringRefs(this.stringRefs[i - 1], this.stringRefs[i]) > 0) {
        this.stringRefs.sort(compareStringRefs);
        break;
      }
    }
    if (!this.callbacks.endData) return ReadStatError.OK;
    return this.callbacks.endData(this);
  }

  emitError(message: string): void {
    if (this.errorHandler) this.errorHandler(message);
  }
}

/** Encode a JS string as raw bytes using latin1 (byte = charCode & 0xff). */
export function latin1Bytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}
