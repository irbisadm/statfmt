//
// spss/sav-write.ts — SAV writer (port of readstat_sav_write.c)
//

import { ReadStatError } from "../errors.js";
import { ReadStatType, ReadStatCompress, ReadStatTypeClass } from "../types.js";
import { Writer } from "../writer.js";
import { Variable } from "../variable.js";
import { LabelSet } from "../labelset.js";
import { BinaryWriter } from "../binary.js";
import { machineIsLittleEndian } from "../bits.js";
import {
  SpssFormat,
  spssFormatForVariable,
  spss64bitValue,
  spssMeasureFromReadstat,
  spssAlignmentFromReadstat,
  SAV_MISSING_DOUBLE,
  SAV_HIGHEST_DOUBLE,
  SAV_LOWEST_DOUBLE,
  SPSS_DOC_LINE_SIZE,
} from "./spss.js";
import {
  SAV_RECORD_TYPE_VARIABLE,
  SAV_RECORD_TYPE_VALUE_LABEL,
  SAV_RECORD_TYPE_VALUE_LABEL_VARIABLES,
  SAV_RECORD_TYPE_DOCUMENT,
  SAV_RECORD_TYPE_HAS_DATA,
  SAV_RECORD_TYPE_DICT_TERMINATION,
  SAV_RECORD_SUBTYPE_INTEGER_INFO,
  SAV_RECORD_SUBTYPE_FP_INFO,
  SAV_RECORD_SUBTYPE_VAR_DISPLAY,
  SAV_RECORD_SUBTYPE_LONG_VAR_NAME,
  SAV_RECORD_SUBTYPE_VERY_LONG_STR,
  SAV_RECORD_SUBTYPE_NUMBER_OF_CASES,
  SAV_RECORD_SUBTYPE_LONG_STRING_VALUE_LABELS,
  SAV_RECORD_SUBTYPE_LONG_STRING_MISSING_VALUES,
  SAV_FLOATING_POINT_REP_IEEE,
  SAV_ENDIANNESS_LITTLE,
  SAV_ENDIANNESS_BIG,
} from "./sav.js";
import { savCompressedRowBound, savCompressRow } from "./sav-compress.js";
import { PRODUCT_URL } from "./product.js";
import { ZsavCtx, zsavWriteCompressedRow, zsavEndData } from "./zsav-write.js";

const MAX_STRING_SIZE = 255;
const MAX_LABEL_SIZE = 256;
const MAX_VALUE_LABEL_SIZE = 120;

const utf8 = new TextEncoder();
function enc(s: string): Uint8Array {
  return utf8.encode(s);
}

interface SavVarnames {
  shortname: string;
  stem: string;
}

// ---- helpers for label-set classification ----

function labelSetNumberShortVariables(ls: LabelSet): number {
  let count = 0;
  for (const v of ls.variables) {
    if (v.storageWidth <= 8) count++;
  }
  return count;
}
function labelSetNeedsShort(ls: LabelSet): boolean {
  return labelSetNumberShortVariables(ls) > 0;
}
function labelSetNeedsLong(ls: LabelSet): boolean {
  return labelSetNumberShortVariables(ls) < ls.variables.length;
}

function savEncodeFormat(f: SpssFormat): number {
  const width = f.width > 0xff ? 0xff : f.width;
  return ((f.type << 16) | (width << 8) | f.decimalPlaces) | 0;
}

function savEncodeBaseVariableFormat(v: Variable): { retval: ReadStatError; code: number } {
  const { retval, format } = spssFormatForVariable(v);
  return { retval, code: retval === ReadStatError.OK ? savEncodeFormat(format) : 0 };
}
function savEncodeGhostVariableFormat(v: Variable, userWidth: number): { retval: ReadStatError; code: number } {
  const { retval, format } = spssFormatForVariable(v);
  format.width = userWidth;
  return { retval, code: retval === ReadStatError.OK ? savEncodeFormat(format) : 0 };
}

function savVariableSegments(type: ReadStatType, userWidth: number): number {
  if (type === ReadStatType.STRING && userWidth > MAX_STRING_SIZE) {
    return Math.floor((userWidth + 251) / 252);
  }
  return 1;
}

function ghostVariableName(varnames: SavVarnames, segment: number): string {
  let out = varnames.stem;
  const letter = segment % 36;
  if (letter < 10) out += String.fromCharCode(0x30 + letter);
  else out += String.fromCharCode(0x41 + (letter - 10));
  return out;
}

// ---- record emitters ----

function emitI32(writer: Writer, v: number): ReadStatError {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v | 0, true);
  return writer.writeBytes(b);
}

function emitU64(writer: Writer, v: bigint): ReadStatError {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return writer.writeBytes(b);
}

function infoHeader(recType: number, subtype: number, size: number, count: number): Uint8Array {
  const bw = new BinaryWriter(true, 16);
  bw.i32(recType).i32(subtype).i32(size).i32(count);
  return bw.finish();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  const s = String(n % 100);
  return s.length >= 2 ? s : "0" + s;
}

function savEmitHeader(writer: Writer): ReadStatError {
  const d = new Date(writer.timestamp * 1000);
  const creationDate = `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${pad2(d.getFullYear() % 100)}`;
  const creationTime = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  const bw = new BinaryWriter(true, 176);
  // rec_type[4]
  const recType = writer.compression === ReadStatCompress.BINARY ? "$FL3" : "$FL2";
  bw.bytes(latin1(recType));
  // prod_name[60] space padded
  const prod = "@(#) SPSS DATA FILE - " + PRODUCT_URL;
  const prodBytes = new Uint8Array(60).fill(0x20);
  prodBytes.set(latin1(prod).subarray(0, 60));
  bw.bytes(prodBytes);
  bw.i32(2); // layout_code
  bw.i32(Math.floor(writer.rowLen / 8)); // nominal_case_size
  bw.i32(
    writer.compression === ReadStatCompress.ROWS
      ? 1
      : writer.compression === ReadStatCompress.BINARY
      ? 2
      : 0,
  );
  bw.i32(writer.fweightVariable ? 1 + Math.floor(writer.fweightVariable.offset / 8) : 0); // weight_index
  bw.i32(writer.rowCount); // ncases
  bw.f64(100.0); // bias
  bw.bytes(fixedAscii(creationDate, 9));
  bw.bytes(fixedAscii(creationTime, 8));
  // file_label[64] space padded
  const fileLabel = new Uint8Array(64).fill(0x20);
  if (writer.fileLabel) {
    const fl = enc(writer.fileLabel);
    fileLabel.set(fl.subarray(0, 64));
  }
  bw.bytes(fileLabel);
  bw.zeros(3); // padding
  return writer.writeBytes(bw.finish());
}

function savEmitVariableLabel(writer: Writer, v: Variable): ReadStatError {
  const titleBytes = enc(v.label);
  if (titleBytes.length === 0) return ReadStatError.OK;
  let labelLen = titleBytes.length;
  if (labelLen > MAX_LABEL_SIZE) labelLen = MAX_LABEL_SIZE;
  let retval = emitI32(writer, labelLen);
  if (retval !== ReadStatError.OK) return retval;
  const rounded = (Math.floor((labelLen + 3) / 4)) * 4;
  const buf = new Uint8Array(rounded);
  buf.set(titleBytes.subarray(0, Math.min(titleBytes.length, rounded)));
  retval = writer.writeBytes(buf);
  return retval;
}

function savNMissingDoubleValues(v: Variable): number {
  const n = v.getMissingRangesCount();
  let count = n;
  let hasRange = false;
  for (let j = 0; j < n; j++) {
    const lo = v.getMissingRangeLo(j);
    const hi = v.getMissingRangeHi(j);
    if (spss64bitValue(lo) !== spss64bitValue(hi)) {
      count++;
      hasRange = true;
    }
  }
  return hasRange ? -count : count;
}
function savNMissingStringValues(v: Variable): number {
  const n = v.getMissingRangesCount();
  let count = n;
  let hasRange = false;
  for (let j = 0; j < n; j++) {
    const lo = v.getMissingRangeLo(j).stringValue();
    const hi = v.getMissingRangeHi(j).stringValue();
    if (lo !== null && hi !== null && lo !== hi) {
      count++;
      hasRange = true;
    }
  }
  return hasRange ? -count : count;
}
function savNMissingValues(v: Variable): { retval: ReadStatError; n: number } {
  let n = 0;
  if (v.getTypeClass() === ReadStatTypeClass.NUMERIC) {
    n = savNMissingDoubleValues(v);
  } else if (v.storageWidth <= 8) {
    n = savNMissingStringValues(v);
  }
  if (Math.abs(n) > 3) return { retval: ReadStatError.ERROR_TOO_MANY_MISSING_VALUE_DEFINITIONS, n: 0 };
  return { retval: ReadStatError.OK, n };
}

function savEmitVariableMissingStringValues(writer: Writer, v: Variable): ReadStatError {
  const n = v.getMissingRangesCount();
  let retval = ReadStatError.OK;
  // ranges
  for (let j = 0; j < n; j++) {
    const lo = v.getMissingRangeLo(j).stringValue();
    const hi = v.getMissingRangeHi(j).stringValue();
    if (lo !== null && hi !== null && lo !== hi) {
      if ((retval = writer.writeSpacePaddedString(lo, 8)) !== ReadStatError.OK) return retval;
      if ((retval = writer.writeSpacePaddedString(hi, 8)) !== ReadStatError.OK) return retval;
      break;
    }
  }
  // values
  let nMissing = 0;
  for (let j = 0; j < n; j++) {
    const lo = v.getMissingRangeLo(j).stringValue();
    const hi = v.getMissingRangeHi(j).stringValue();
    if (lo !== null && hi !== null && lo === hi) {
      if ((retval = writer.writeSpacePaddedString(lo, 8)) !== ReadStatError.OK) return retval;
      if (++nMissing === 3) break;
    }
  }
  return retval;
}
function savEmitVariableMissingDoubleValues(writer: Writer, v: Variable): ReadStatError {
  const n = v.getMissingRangesCount();
  let retval = ReadStatError.OK;
  for (let j = 0; j < n; j++) {
    const lo = v.getMissingRangeLo(j);
    const hi = v.getMissingRangeHi(j);
    if (spss64bitValue(lo) !== spss64bitValue(hi)) {
      if ((retval = emitU64(writer, spss64bitValue(lo))) !== ReadStatError.OK) return retval;
      if ((retval = emitU64(writer, spss64bitValue(hi))) !== ReadStatError.OK) return retval;
      break;
    }
  }
  let nMissing = 0;
  for (let j = 0; j < n; j++) {
    const lo = v.getMissingRangeLo(j);
    const hi = v.getMissingRangeHi(j);
    if (spss64bitValue(lo) === spss64bitValue(hi)) {
      if ((retval = emitU64(writer, spss64bitValue(lo))) !== ReadStatError.OK) return retval;
      if (++nMissing === 3) break;
    }
  }
  return retval;
}
function savEmitVariableMissingValues(writer: Writer, v: Variable): ReadStatError {
  if (v.getTypeClass() === ReadStatTypeClass.NUMERIC) {
    return savEmitVariableMissingDoubleValues(writer, v);
  } else if (v.storageWidth <= 8) {
    return savEmitVariableMissingStringValues(writer, v);
  }
  return ReadStatError.OK;
}

function savEmitBlankVariableRecords(writer: Writer, extraFields: number): ReadStatError {
  let retval = ReadStatError.OK;
  while (extraFields-- > 0) {
    if ((retval = emitI32(writer, SAV_RECORD_TYPE_VARIABLE)) !== ReadStatError.OK) return retval;
    const bw = new BinaryWriter(true, 28);
    bw.i32(-1); // type
    bw.i32(0); // has_var_label
    bw.i32(0); // n_missing_values
    bw.i32(0x011d01); // print
    bw.i32(0x011d01); // write
    bw.bytes(new Uint8Array(8).fill(0x20)); // name (spaces)
    if ((retval = writer.writeBytes(bw.finish())) !== ReadStatError.OK) return retval;
  }
  return retval;
}

function savEmitBaseVariableRecord(writer: Writer, v: Variable, varnames: SavVarnames): ReadStatError {
  let retval = ReadStatError.OK;
  const nameData = enc(varnames.shortname);

  if ((retval = emitI32(writer, SAV_RECORD_TYPE_VARIABLE)) !== ReadStatError.OK) return retval;

  let type = 0;
  if (v.type === ReadStatType.STRING) {
    type = v.userWidth > MAX_STRING_SIZE ? MAX_STRING_SIZE : v.userWidth;
  }
  const hasVarLabel = v.label.length > 0 ? 1 : 0;
  const nm = savNMissingValues(v);
  if (nm.retval !== ReadStatError.OK) return nm.retval;
  const fmt = savEncodeBaseVariableFormat(v);
  if (fmt.retval !== ReadStatError.OK) return fmt.retval;

  const bw = new BinaryWriter(true, 28);
  bw.i32(type);
  bw.i32(hasVarLabel);
  bw.i32(nm.n);
  bw.i32(fmt.code); // print
  bw.i32(fmt.code); // write
  const nameField = new Uint8Array(8).fill(0x20);
  if (nameData.length > 0 && nameData.length <= 8) nameField.set(nameData);
  bw.bytes(nameField);
  if ((retval = writer.writeBytes(bw.finish())) !== ReadStatError.OK) return retval;

  if ((retval = savEmitVariableLabel(writer, v)) !== ReadStatError.OK) return retval;
  if ((retval = savEmitVariableMissingValues(writer, v)) !== ReadStatError.OK) return retval;

  let extraFields = Math.floor(v.storageWidth / 8) - 1;
  if (extraFields > 31) extraFields = 31;
  return savEmitBlankVariableRecords(writer, extraFields);
}

function savEmitGhostVariableRecord(
  writer: Writer,
  v: Variable,
  varnames: SavVarnames,
  segment: number,
  userWidth: number,
): ReadStatError {
  let retval = ReadStatError.OK;
  const nameStr = ghostVariableName(varnames, segment);
  const nameData = enc(nameStr);
  if ((retval = emitI32(writer, SAV_RECORD_TYPE_VARIABLE)) !== ReadStatError.OK) return retval;

  const fmt = savEncodeGhostVariableFormat(v, userWidth);
  if (fmt.retval !== ReadStatError.OK) return fmt.retval;

  const bw = new BinaryWriter(true, 28);
  bw.i32(userWidth); // type
  bw.i32(0); // has_var_label
  bw.i32(0); // n_missing_values
  bw.i32(fmt.code); // print
  bw.i32(fmt.code); // write
  const nameField = new Uint8Array(8).fill(0x20);
  if (nameData.length > 0 && nameData.length <= 8) nameField.set(nameData);
  bw.bytes(nameField);
  if ((retval = writer.writeBytes(bw.finish())) !== ReadStatError.OK) return retval;

  let extraFields = Math.floor((userWidth + 7) / 8) - 1;
  if (extraFields > 31) extraFields = 31;
  return savEmitBlankVariableRecords(writer, extraFields);
}

function savEmitFullVariableRecord(writer: Writer, v: Variable, varnames: SavVarnames): ReadStatError {
  let retval = savEmitBaseVariableRecord(writer, v, varnames);
  if (retval !== ReadStatError.OK) return retval;
  const nSegments = savVariableSegments(v.type, v.userWidth);
  for (let i = 1; i < nSegments; i++) {
    let storageSize = MAX_STRING_SIZE;
    if (i === nSegments - 1) {
      storageSize = v.userWidth - (nSegments - 1) * 252;
    }
    retval = savEmitGhostVariableRecord(writer, v, varnames, i, storageSize);
    if (retval !== ReadStatError.OK) return retval;
  }
  return ReadStatError.OK;
}

function savEmitVariableRecords(writer: Writer, varnames: SavVarnames[]): ReadStatError {
  for (let i = 0; i < writer.variables.length; i++) {
    const retval = savEmitFullVariableRecord(writer, writer.variables[i], varnames[i]);
    if (retval !== ReadStatError.OK) return retval;
  }
  return ReadStatError.OK;
}

function savEmitValueLabelRecords(writer: Writer): ReadStatError {
  let retval = ReadStatError.OK;
  for (const ls of writer.labelSets) {
    if (!labelSetNeedsShort(ls)) continue;
    const userType = ls.type;
    const labelCount = ls.valueLabels.length;
    if (!labelCount) continue;

    if ((retval = emitI32(writer, SAV_RECORD_TYPE_VALUE_LABEL)) !== ReadStatError.OK) return retval;
    if ((retval = emitI32(writer, labelCount)) !== ReadStatError.OK) return retval;

    for (const vl of ls.valueLabels) {
      const value = new Uint8Array(8);
      if (userType === ReadStatType.STRING) {
        value.fill(0x20);
        const key = enc(vl.stringKey ?? "");
        value.set(key.subarray(0, 8));
      } else if (userType === ReadStatType.DOUBLE) {
        new DataView(value.buffer).setFloat64(0, vl.doubleKey, true);
      } else if (userType === ReadStatType.INT32) {
        new DataView(value.buffer).setFloat64(0, vl.int32Key, true);
      }
      if ((retval = writer.writeBytes(value)) !== ReadStatError.OK) return retval;

      const labelBytes = enc(vl.label);
      let labelLen = MAX_VALUE_LABEL_SIZE;
      if (labelLen > labelBytes.length) labelLen = labelBytes.length;
      if ((retval = writer.writeBytes(new Uint8Array([labelLen]))) !== ReadStatError.OK) return retval;

      const total = (Math.floor((labelLen + 1 + 7) / 8)) * 8 - 1;
      const labelBuf = new Uint8Array(total).fill(0x20);
      labelBuf.set(labelBytes.subarray(0, labelLen));
      if ((retval = writer.writeBytes(labelBuf)) !== ReadStatError.OK) return retval;
    }

    if ((retval = emitI32(writer, SAV_RECORD_TYPE_VALUE_LABEL_VARIABLES)) !== ReadStatError.OK) return retval;
    const varCount = labelSetNumberShortVariables(ls);
    if ((retval = emitI32(writer, varCount)) !== ReadStatError.OK) return retval;
    for (const v of ls.variables) {
      if (v.storageWidth > 8) continue;
      const dictionaryIndex = 1 + Math.floor(v.offset / 8);
      if ((retval = emitI32(writer, dictionaryIndex)) !== ReadStatError.OK) return retval;
    }
  }
  return retval;
}

function savEmitDocumentRecord(writer: Writer): ReadStatError {
  if (writer.notes.length === 0) return ReadStatError.OK;
  let retval = ReadStatError.OK;
  if ((retval = emitI32(writer, SAV_RECORD_TYPE_DOCUMENT)) !== ReadStatError.OK) return retval;
  if ((retval = emitI32(writer, writer.notes.length)) !== ReadStatError.OK) return retval;
  for (const note of writer.notes) {
    const noteBytes = enc(note);
    if (noteBytes.length > SPSS_DOC_LINE_SIZE) return ReadStatError.ERROR_NOTE_IS_TOO_LONG;
    if ((retval = writer.writeBytes(noteBytes)) !== ReadStatError.OK) return retval;
    if ((retval = writer.writeSpaces(SPSS_DOC_LINE_SIZE - noteBytes.length)) !== ReadStatError.OK) return retval;
  }
  return retval;
}

function savEmitIntegerInfoRecord(writer: Writer): ReadStatError {
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_INTEGER_INFO, 4, 8),
  );
  if (retval !== ReadStatError.OK) return retval;
  const bw = new BinaryWriter(true, 32);
  bw.i32(20); // version_major
  bw.i32(0); // version_minor
  bw.i32(0); // version_revision
  bw.i32(-1); // machine_code
  bw.i32(SAV_FLOATING_POINT_REP_IEEE);
  bw.i32(1); // compression_code
  bw.i32(machineIsLittleEndian() ? SAV_ENDIANNESS_LITTLE : SAV_ENDIANNESS_BIG);
  bw.i32(65001); // UTF-8
  retval = writer.writeBytes(bw.finish());
  return retval;
}

function savEmitFloatingPointInfoRecord(writer: Writer): ReadStatError {
  let retval = writer.writeBytes(infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_FP_INFO, 8, 3));
  if (retval !== ReadStatError.OK) return retval;
  if ((retval = emitU64(writer, SAV_MISSING_DOUBLE)) !== ReadStatError.OK) return retval;
  if ((retval = emitU64(writer, SAV_HIGHEST_DOUBLE)) !== ReadStatError.OK) return retval;
  if ((retval = emitU64(writer, SAV_LOWEST_DOUBLE)) !== ReadStatError.OK) return retval;
  return retval;
}

function savEmitVariableDisplayRecord(writer: Writer): ReadStatError {
  let totalSegments = 0;
  for (const v of writer.variables) {
    totalSegments += savVariableSegments(v.type, v.userWidth);
  }
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_VAR_DISPLAY, 4, 3 * totalSegments),
  );
  if (retval !== ReadStatError.OK) return retval;
  for (const v of writer.variables) {
    const savMeasure = spssMeasureFromReadstat(v.measure);
    let savDisplayWidth = v.displayWidth;
    if (savDisplayWidth <= 0) savDisplayWidth = 8;
    const savAlignment = spssAlignmentFromReadstat(v.alignment);
    let n = savVariableSegments(v.type, v.userWidth);
    while (n-- > 0) {
      if ((retval = emitI32(writer, savMeasure)) !== ReadStatError.OK) return retval;
      if ((retval = emitI32(writer, savDisplayWidth)) !== ReadStatError.OK) return retval;
      if ((retval = emitI32(writer, savAlignment)) !== ReadStatError.OK) return retval;
    }
  }
  return retval;
}

function savEmitLongVarNameRecord(writer: Writer, varnames: SavVarnames[]): ReadStatError {
  let count = 0;
  for (let i = 0; i < writer.variables.length; i++) {
    const nameData = enc(varnames[i].shortname);
    let titleLen = enc(writer.variables[i].name).length;
    if (titleLen > 0 && nameData.length > 0) {
      if (titleLen > 64) titleLen = 64;
      count += nameData.length + 1 /* '=' */ + titleLen + 1 /* 0x09 */;
    }
  }
  if (count === 0) return ReadStatError.OK;
  count--; // no trailing 0x09
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_LONG_VAR_NAME, 1, count),
  );
  if (retval !== ReadStatError.OK) return retval;

  let isFirst = true;
  for (let i = 0; i < writer.variables.length; i++) {
    const nameData = enc(varnames[i].shortname);
    let titleBytes = enc(writer.variables[i].name);
    if (titleBytes.length > 0) {
      if (titleBytes.length > 64) titleBytes = titleBytes.subarray(0, 64);
      if (!isFirst) {
        if ((retval = writer.writeBytes(new Uint8Array([0x09]))) !== ReadStatError.OK) return retval;
      }
      if ((retval = writer.writeBytes(nameData)) !== ReadStatError.OK) return retval;
      if ((retval = writer.writeBytes(new Uint8Array([0x3d]))) !== ReadStatError.OK) return retval;
      if ((retval = writer.writeBytes(titleBytes)) !== ReadStatError.OK) return retval;
      isFirst = false;
    }
  }
  return retval;
}

function savEmitVeryLongStringRecord(writer: Writer, varnames: SavVarnames[]): ReadStatError {
  let count = 0;
  for (let i = 0; i < writer.variables.length; i++) {
    const v = writer.variables[i];
    if (v.userWidth <= MAX_STRING_SIZE) continue;
    const kv = `${varnames[i].shortname.slice(0, 8)}=${v.userWidth % 100000}`;
    count += enc(kv).length + 2; // + { 0x00, 0x09 }
  }
  if (count === 0) return ReadStatError.OK;
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_VERY_LONG_STR, 1, count),
  );
  if (retval !== ReadStatError.OK) return retval;
  for (let i = 0; i < writer.variables.length; i++) {
    const v = writer.variables[i];
    if (v.userWidth <= MAX_STRING_SIZE) continue;
    const kv = `${varnames[i].shortname.slice(0, 8)}=${v.userWidth % 100000}`;
    if ((retval = writer.writeBytes(enc(kv))) !== ReadStatError.OK) return retval;
    if ((retval = writer.writeBytes(new Uint8Array([0x00, 0x09]))) !== ReadStatError.OK) return retval;
  }
  return retval;
}

function savEmitLongStringValueLabelsRecord(writer: Writer): ReadStatError {
  let count = 0;
  for (const ls of writer.labelSets) {
    if (!labelSetNeedsLong(ls)) continue;
    const labelCount = ls.valueLabels.length;
    for (const v of ls.variables) {
      const nameLen = enc(v.name).length;
      const userWidth = v.userWidth;
      if (v.storageWidth <= 8) continue;
      count += 4 + nameLen + 4 + 4;
      for (const vl of ls.valueLabels) {
        let labelLen = enc(vl.label).length;
        if (labelLen > MAX_VALUE_LABEL_SIZE) labelLen = MAX_VALUE_LABEL_SIZE;
        const keyLen = enc(vl.stringKey ?? "").length;
        if (keyLen > userWidth) return ReadStatError.ERROR_STRING_VALUE_IS_TOO_LONG;
        count += 4 + userWidth + 4 + labelLen;
      }
    }
  }
  if (count === 0) return ReadStatError.OK;
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_LONG_STRING_VALUE_LABELS, 1, count),
  );
  if (retval !== ReadStatError.OK) return retval;

  for (const ls of writer.labelSets) {
    if (!labelSetNeedsLong(ls)) continue;
    for (const v of ls.variables) {
      const nameBytes = enc(v.name);
      const userWidth = v.userWidth;
      if (v.storageWidth <= 8) continue;

      if ((retval = emitI32(writer, nameBytes.length)) !== ReadStatError.OK) return retval;
      if ((retval = writer.writeBytes(nameBytes)) !== ReadStatError.OK) return retval;
      if ((retval = emitI32(writer, userWidth)) !== ReadStatError.OK) return retval;
      if ((retval = emitI32(writer, ls.valueLabels.length)) !== ReadStatError.OK) return retval;

      for (const vl of ls.valueLabels) {
        const keyBytes = enc(vl.stringKey ?? "");
        const valueLen = keyBytes.length;
        let labelBytes = enc(vl.label);
        let labelLen = labelBytes.length;
        if (labelLen > MAX_VALUE_LABEL_SIZE) labelLen = MAX_VALUE_LABEL_SIZE;

        if ((retval = emitI32(writer, userWidth)) !== ReadStatError.OK) return retval;
        if ((retval = writer.writeBytes(keyBytes)) !== ReadStatError.OK) return retval;
        if (valueLen < userWidth) {
          if ((retval = writer.writeBytes(new Uint8Array(userWidth - valueLen).fill(0x20))) !== ReadStatError.OK)
            return retval;
        }
        if ((retval = emitI32(writer, labelLen)) !== ReadStatError.OK) return retval;
        if ((retval = writer.writeBytes(labelBytes.subarray(0, labelLen))) !== ReadStatError.OK) return retval;
      }
    }
  }
  return retval;
}

function savEmitLongStringMissingValuesRecord(writer: Writer): ReadStatError {
  let count = 0;
  for (const v of writer.variables) {
    const nameLen = enc(v.name).length;
    if (v.storageWidth <= 8) continue;
    let nMissing = 0;
    for (let j = 0; j < v.getMissingRangesCount(); j++) {
      const lo = v.getMissingRangeLo(j).stringValue();
      const hi = v.getMissingRangeHi(j).stringValue();
      if (lo !== null && hi !== null && lo === hi) nMissing++;
    }
    if (nMissing) {
      count += 4 + nameLen + 1 + 4 + 8 * nMissing;
    }
  }
  if (count === 0) return ReadStatError.OK;
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_LONG_STRING_MISSING_VALUES, 1, count),
  );
  if (retval !== ReadStatError.OK) return retval;

  for (const v of writer.variables) {
    const nameBytes = enc(v.name);
    if (v.storageWidth <= 8) continue;
    let nMissing = 0;
    for (let j = 0; j < v.getMissingRangesCount(); j++) {
      const lo = v.getMissingRangeLo(j).stringValue();
      const hi = v.getMissingRangeHi(j).stringValue();
      if (lo !== null && hi !== null && lo === hi) nMissing++;
    }
    if (nMissing === 0) continue;

    if ((retval = emitI32(writer, nameBytes.length)) !== ReadStatError.OK) return retval;
    if ((retval = writer.writeBytes(nameBytes)) !== ReadStatError.OK) return retval;
    if ((retval = writer.writeBytes(new Uint8Array([nMissing]))) !== ReadStatError.OK) return retval;
    if ((retval = emitI32(writer, 8)) !== ReadStatError.OK) return retval;
    for (let j = 0; j < v.getMissingRangesCount(); j++) {
      const lo = v.getMissingRangeLo(j).stringValue();
      const hi = v.getMissingRangeHi(j).stringValue();
      if (lo !== null && hi !== null && lo === hi) {
        if ((retval = writer.writeSpacePaddedString(lo, 8)) !== ReadStatError.OK) return retval;
      }
    }
  }
  return retval;
}

function savEmitNumberOfCasesRecord(writer: Writer): ReadStatError {
  let retval = writer.writeBytes(
    infoHeader(SAV_RECORD_TYPE_HAS_DATA, SAV_RECORD_SUBTYPE_NUMBER_OF_CASES, 8, 2),
  );
  if (retval !== ReadStatError.OK) return retval;
  if ((retval = emitU64(writer, 1n)) !== ReadStatError.OK) return retval;
  if ((retval = emitU64(writer, BigInt(writer.rowCount))) !== ReadStatError.OK) return retval;
  return retval;
}

function savEmitTerminationRecord(writer: Writer): ReadStatError {
  const bw = new BinaryWriter(true, 8);
  bw.i32(SAV_RECORD_TYPE_DICT_TERMINATION).i32(0);
  return writer.writeBytes(bw.finish());
}

// ---- value writers ----

function writeDoubleToRow(writer: Writer, offset: number, value: number): ReadStatError {
  new DataView(writer.row.buffer, writer.row.byteOffset).setFloat64(offset, value, true);
  return ReadStatError.OK;
}

function savWriteString(writer: Writer, offset: number, variable: Variable, value: string): ReadStatError {
  writer.row.fill(0x20, offset, offset + variable.storageWidth);
  if (value && value.length > 0) {
    const valueBytes = enc(value);
    if (valueBytes.length > variable.storageWidth) return ReadStatError.ERROR_STRING_VALUE_IS_TOO_LONG;
    let rowOffset = 0;
    let valOffset = 0;
    while (valueBytes.length - valOffset > 255) {
      writer.row.set(valueBytes.subarray(valOffset, valOffset + 255), offset + rowOffset);
      rowOffset += 256;
      valOffset += 255;
    }
    writer.row.set(valueBytes.subarray(valOffset), offset + rowOffset);
  }
  return ReadStatError.OK;
}

function savWriteMissingString(writer: Writer, offset: number, variable: Variable): ReadStatError {
  writer.row.fill(0x20, offset, offset + variable.storageWidth);
  return ReadStatError.OK;
}

function savWriteMissingNumber(writer: Writer, offset: number): ReadStatError {
  new DataView(writer.row.buffer, writer.row.byteOffset).setBigUint64(offset, SAV_MISSING_DOUBLE, true);
  return ReadStatError.OK;
}

function savVariableWidth(type: ReadStatType, userWidth: number): number {
  if (type === ReadStatType.STRING) {
    if (userWidth > MAX_STRING_SIZE) {
      const nSegments = savVariableSegments(type, userWidth);
      const lastSegmentWidth = Math.floor((userWidth - (nSegments - 1) * 252 + 7) / 8) * 8;
      return (nSegments - 1) * 256 + lastSegmentWidth;
    }
    if (userWidth === 0) return 8;
    return Math.floor((userWidth + 7) / 8) * 8;
  }
  return 8;
}

// ---- name validation ----

const RESERVED = new Set([
  "ALL", "AND", "BY", "EQ", "GE", "GT", "LE", "LT", "NE", "NOT", "OR", "TO", "WITH",
]);

function savValidateNameChars(name: string): ReadStatError {
  for (let j = 0; j < name.length; j++) {
    const c = name[j];
    if (c === " ") return ReadStatError.ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER;
    const code = name.charCodeAt(j);
    if (
      code < 0x80 &&
      c !== "@" && c !== "." && c !== "_" && c !== "$" && c !== "#" &&
      !(c >= "a" && c <= "z") && !(c >= "A" && c <= "Z") && !(c >= "0" && c <= "9")
    ) {
      return ReadStatError.ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER;
    }
  }
  const first = name[0];
  const firstCode = name.charCodeAt(0);
  if (firstCode < 0x80 && first !== "@" && !(first >= "a" && first <= "z") && !(first >= "A" && first <= "Z")) {
    return ReadStatError.ERROR_NAME_BEGINS_WITH_ILLEGAL_CHARACTER;
  }
  return ReadStatError.OK;
}

function savValidateName(v: Variable): ReadStatError {
  const nameLen = enc(v.name).length;
  if (nameLen > 64) return ReadStatError.ERROR_NAME_IS_TOO_LONG;
  if (nameLen === 0) return ReadStatError.ERROR_NAME_IS_ZERO_LENGTH;
  if (RESERVED.has(v.name)) return ReadStatError.ERROR_NAME_IS_RESERVED_WORD;
  return savValidateNameChars(v.name);
}

function savVarnamesInit(writer: Writer): SavVarnames[] {
  const varnames: SavVarnames[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < writer.variables.length; i++) {
    const v = writer.variables[i];
    // %.8s of UTF-8 bytes, uppercased (ASCII)
    let shortBytes = enc(v.name).subarray(0, 8);
    let shortname = latin1Decode(shortBytes).toUpperCase();
    if (seen.has(shortname)) {
      shortname = `V${(i + 1) % 100000}_A`;
    }
    seen.add(shortname);
    let stem = "";
    if (v.userWidth > MAX_STRING_SIZE) {
      stem = shortname.slice(0, 5);
    }
    varnames.push({ shortname, stem });
  }
  return varnames;
}

function savBeginData(writer: Writer): ReadStatError {
  if (!writer.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
  const varnames = savVarnamesInit(writer);
  let retval = ReadStatError.OK;
  const steps: ((w: Writer) => ReadStatError)[] = [
    savEmitHeader,
    (w) => savEmitVariableRecords(w, varnames),
    savEmitValueLabelRecords,
    savEmitDocumentRecord,
    savEmitIntegerInfoRecord,
    savEmitFloatingPointInfoRecord,
    savEmitVariableDisplayRecord,
    (w) => savEmitLongVarNameRecord(w, varnames),
    (w) => savEmitVeryLongStringRecord(w, varnames),
    savEmitLongStringValueLabelsRecord,
    savEmitLongStringMissingValuesRecord,
    savEmitNumberOfCasesRecord,
    savEmitTerminationRecord,
  ];
  for (const step of steps) {
    retval = step(writer);
    if (retval !== ReadStatError.OK) return retval;
  }
  if (writer.compression === ReadStatCompress.ROWS) {
    writer.moduleCtx = new Uint8Array(savCompressedRowBound(writer.rowLen));
  } else if (writer.compression === ReadStatCompress.BINARY) {
    writer.moduleCtx = new ZsavCtx(savCompressedRowBound(writer.rowLen), writer.bytesWritten);
  }
  return retval;
}

function savWriteCompressedRow(writer: Writer, row: Uint8Array): ReadStatError {
  const output = writer.moduleCtx as Uint8Array;
  const outputOffset = savCompressRow(output, row, writer);
  return writer.writeBytes(output.subarray(0, outputOffset));
}

function savMetadataOk(writer: Writer): ReadStatError {
  if (writer.version === 2 && writer.compression === ReadStatCompress.BINARY) {
    return ReadStatError.ERROR_UNSUPPORTED_COMPRESSION;
  }
  if (writer.version !== 2 && writer.version !== 3) {
    return ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION;
  }
  return ReadStatError.OK;
}

export function beginWritingSav(writer: Writer, userCtx: unknown, rowCount: number): ReadStatError {
  writer.callbacks.metadataOk = savMetadataOk;
  writer.callbacks.variableWidth = savVariableWidth;
  writer.callbacks.variableOk = savValidateName;
  writer.callbacks.writeInt8 = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeInt16 = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeInt32 = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeFloat = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeDouble = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeString = savWriteString;
  writer.callbacks.writeMissingString = savWriteMissingString;
  writer.callbacks.writeMissingNumber = (w, off) => savWriteMissingNumber(w, off);
  writer.callbacks.beginData = savBeginData;

  if (writer.version === 3) {
    writer.compression = ReadStatCompress.BINARY;
  } else if (writer.version === 0) {
    writer.version = writer.compression === ReadStatCompress.BINARY ? 3 : 2;
  }

  if (writer.compression === ReadStatCompress.ROWS) {
    writer.callbacks.writeRow = (w, row) => savWriteCompressedRow(w, row);
  } else if (writer.compression === ReadStatCompress.BINARY) {
    writer.callbacks.writeRow = (w, row) => zsavWriteCompressedRow(w, row);
    writer.callbacks.endData = (w) => zsavEndData(w);
  } else if (writer.compression === ReadStatCompress.NONE) {
    /* void — default row writer */
  } else {
    return ReadStatError.ERROR_UNSUPPORTED_COMPRESSION;
  }

  return writer.beginWritingFile(userCtx, rowCount);
}

// ---- tiny ascii/latin1 helpers ----

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function latin1Decode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
function fixedAscii(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const b = latin1(s);
  out.set(b.subarray(0, len));
  return out;
}
