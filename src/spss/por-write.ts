//
// spss/por-write.ts — SPSS portable (.por) writer (port of readstat_por_write.c)
//

import { ReadStatError } from "../errors.js";
import { ReadStatType, ReadStatCompress } from "../types.js";
import { Writer } from "../writer.js";
import { Variable } from "../variable.js";
import { POR_ASCII_LOOKUP, POR_UNICODE_LOOKUP } from "./por.js";
import { spssFormatForVariable, SpssFormat, SPSS_DOC_LINE_SIZE } from "./spss.js";
import { PRODUCT_NAME, PRODUCT_URL } from "./product.js";

const POR_BASE30_PRECISION = 50;
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

class PorWriteCtx {
  unicode2byte: Uint8Array;
  constructor() {
    let maxUnicode = 0;
    for (const u of POR_UNICODE_LOOKUP) if (u > maxUnicode) maxUnicode = u;
    this.unicode2byte = new Uint8Array(maxUnicode + 1);
    for (let i = 0; i < 256; i++) {
      if (POR_UNICODE_LOOKUP[i]) this.unicode2byte[POR_UNICODE_LOOKUP[i]] = POR_ASCII_LOOKUP[i];
      if (POR_ASCII_LOOKUP[i]) this.unicode2byte[POR_ASCII_LOOKUP[i]] = POR_ASCII_LOOKUP[i];
    }
  }
}

function base30Digit(d: number): number {
  return d < 10 ? 0x30 + d : 0x41 + (d - 10);
}

function writeBase30Integer(out: number[], integer: number): void {
  const digits: number[] = [];
  while (integer > 0) {
    digits.push(base30Digit(integer % 30));
    integer = Math.floor(integer / 30);
  }
  for (let i = digits.length - 1; i >= 0; i--) out.push(digits[i]);
}

/** Encode a double in base-30 POR notation. Returns ASCII bytes (no NUL). */
function encodeDoubleBase30(value: number, precision: number): Uint8Array | null {
  const out: number[] = [];
  if (Number.isNaN(value)) {
    out.push(0x2a, 0x2e); // "*."
  } else if (!Number.isFinite(value)) {
    if (value < 0) out.push(0x2d);
    out.push(0x31, 0x2b, 0x54, 0x54, 0x2f); // "1+TT/"
  } else {
    const absv = Math.abs(value);
    let integer = Math.floor(absv);
    let fraction = absv - integer;
    let exponent = 0;
    let integersPrinted = 0;
    if (value < 0) out.push(0x2d);
    if (integer === 0) {
      out.push(0x30);
    } else {
      while (fraction === 0 && integer !== 0 && integer % 30 === 0) {
        integer = Math.floor(integer / 30);
        exponent++;
      }
      const before = out.length;
      writeBase30Integer(out, integer);
      integersPrinted = out.length - before;
    }
    if (fraction) out.push(0x2e); // '.'
    while (fraction && integersPrinted < precision) {
      const scaled = fraction * 30;
      const ip = Math.floor(scaled);
      fraction = scaled - ip;
      if (ip < 0) return null;
      out.push(base30Digit(ip));
      integersPrinted++;
    }
    if (exponent) {
      out.push(0x2b); // '+'
      writeBase30Integer(out, exponent);
    }
    out.push(0x2f); // '/'
  }
  return Uint8Array.from(out);
}

/** Map JS string codepoints to POR bytes. */
function porEncodeString(ctx: PorWriteCtx, str: string): Uint8Array | null {
  const out: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp >= ctx.unicode2byte.length || ctx.unicode2byte[cp] === 0) return null;
    out.push(ctx.unicode2byte[cp]);
  }
  return Uint8Array.from(out);
}

/** Map UTF-8 bytes (via codepoints) to POR bytes. */
function porEncodeBytes(ctx: PorWriteCtx, bytes: Uint8Array): Uint8Array | null {
  return porEncodeString(ctx, utf8Decoder.decode(bytes));
}

function writeAsLines(writer: Writer, bytes: Uint8Array): ReadStatError {
  return writer.writeBytesAsLines(bytes, 80, "\r\n");
}

function writePorString(writer: Writer, ctx: PorWriteCtx, str: string): ReadStatError {
  const b = porEncodeString(ctx, str);
  if (b === null) return ReadStatError.ERROR_CONVERT;
  return writeAsLines(writer, b);
}

function writeTag(writer: Writer, ctx: PorWriteCtx, tag: string): ReadStatError {
  return writePorString(writer, ctx, tag);
}

function writeDoubleField(writer: Writer, ctx: PorWriteCtx, value: number): ReadStatError {
  const b = encodeDoubleBase30(value, POR_BASE30_PRECISION);
  if (b === null) return ReadStatError.ERROR_WRITE;
  const enc = porEncodeBytes(ctx, b);
  if (enc === null) return ReadStatError.ERROR_CONVERT;
  return writeAsLines(writer, enc);
}

function writeStringFieldN(writer: Writer, ctx: PorWriteCtx, str: string, len: number): ReadStatError {
  let e = writeDoubleField(writer, ctx, len);
  if (e !== ReadStatError.OK) return e;
  return writePorString(writer, ctx, str);
}

function writeStringField(writer: Writer, ctx: PorWriteCtx, str: string): ReadStatError {
  return writeStringFieldN(writer, ctx, str, utf8Encoder.encode(str).length);
}

// ---- section emitters ----

function emitHeader(writer: Writer, ctx: PorWriteCtx): ReadStatError {
  const vanity = new Uint8Array(200).fill(0x30); // '0'
  vanity.fill(0x20, 40, 80); // vanity[1] spaces
  const prefix = "ASCII SPSS PORT FILE";
  for (let i = 0; i < 20; i++) vanity[40 + i] = prefix.charCodeAt(i);
  const label = utf8Encoder.encode(writer.fileLabel);
  const labelLen = Math.min(20, label.length);
  vanity.set(label.subarray(0, labelLen), 60);
  let e = writeAsLines(writer, vanity);
  if (e !== ReadStatError.OK) return e;

  const lookup = new Uint8Array(256).fill(0x30);
  for (let i = 0; i < 256; i++) if (POR_ASCII_LOOKUP[i]) lookup[i] = POR_ASCII_LOOKUP[i];
  e = writeAsLines(writer, lookup);
  if (e !== ReadStatError.OK) return e;

  return writePorString(writer, ctx, "SPSSPORT");
}

function pad2(n: number): string {
  const s = String(n % 100);
  return s.length >= 2 ? s : "0" + s;
}
function pad4(n: number): string {
  const s = String(n % 10000);
  return "0000".slice(s.length) + s;
}

function emitVersionAndTimestamp(writer: Writer, ctx: PorWriteCtx): ReadStatError {
  const d = new Date(writer.timestamp * 1000);
  let e = writeTag(writer, ctx, "A");
  if (e !== ReadStatError.OK) return e;
  const date = `${pad4(d.getFullYear())}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  e = writeStringField(writer, ctx, date);
  if (e !== ReadStatError.OK) return e;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return writeStringField(writer, ctx, time);
}

function emitIdentificationRecords(writer: Writer, ctx: PorWriteCtx): ReadStatError {
  let e = writeTag(writer, ctx, "1");
  if (e !== ReadStatError.OK) return e;
  e = writeStringField(writer, ctx, PRODUCT_NAME);
  if (e !== ReadStatError.OK) return e;
  e = writeTag(writer, ctx, "3");
  if (e !== ReadStatError.OK) return e;
  return writeStringField(writer, ctx, PRODUCT_URL);
}

function emitFormat(writer: Writer, ctx: PorWriteCtx, format: SpssFormat): ReadStatError {
  let e = writeDoubleField(writer, ctx, format.type);
  if (e !== ReadStatError.OK) return e;
  e = writeDoubleField(writer, ctx, format.width);
  if (e !== ReadStatError.OK) return e;
  return writeDoubleField(writer, ctx, format.decimalPlaces);
}

function emitMissingValues(writer: Writer, ctx: PorWriteCtx, v: Variable): ReadStatError {
  if (v.type === ReadStatType.DOUBLE) {
    const n = v.getMissingRangesCount();
    let e = ReadStatError.OK;
    for (let j = 0; j < n; j++) {
      const lo = v.getMissingRangeLo(j).doubleValue();
      const hi = v.getMissingRangeHi(j).doubleValue();
      if (!Number.isFinite(lo) && lo < 0) {
        if ((e = writeTag(writer, ctx, "9")) !== ReadStatError.OK) return e;
        if ((e = writeDoubleField(writer, ctx, hi)) !== ReadStatError.OK) return e;
      } else if (!Number.isFinite(hi)) {
        if ((e = writeTag(writer, ctx, "A")) !== ReadStatError.OK) return e;
        if ((e = writeDoubleField(writer, ctx, lo)) !== ReadStatError.OK) return e;
      } else if (lo !== hi) {
        if ((e = writeTag(writer, ctx, "B")) !== ReadStatError.OK) return e;
        if ((e = writeDoubleField(writer, ctx, lo)) !== ReadStatError.OK) return e;
        if ((e = writeDoubleField(writer, ctx, hi)) !== ReadStatError.OK) return e;
      }
    }
    for (let j = 0; j < n; j++) {
      const lo = v.getMissingRangeLo(j).doubleValue();
      const hi = v.getMissingRangeHi(j).doubleValue();
      if (lo === hi && Number.isFinite(lo)) {
        if ((e = writeTag(writer, ctx, "8")) !== ReadStatError.OK) return e;
        if ((e = writeDoubleField(writer, ctx, lo)) !== ReadStatError.OK) return e;
      }
    }
    return ReadStatError.OK;
  } else {
    const n = v.getMissingRangesCount();
    let e = ReadStatError.OK;
    for (let j = 0; j < n; j++) {
      const lo = v.getMissingRangeLo(j).stringValue();
      const hi = v.getMissingRangeHi(j).stringValue();
      if (lo !== null && hi !== null && lo !== hi) {
        if ((e = writeTag(writer, ctx, "B")) !== ReadStatError.OK) return e;
        if ((e = writeStringField(writer, ctx, lo)) !== ReadStatError.OK) return e;
        if ((e = writeStringField(writer, ctx, hi)) !== ReadStatError.OK) return e;
      }
    }
    for (let j = 0; j < n; j++) {
      const lo = v.getMissingRangeLo(j).stringValue();
      const hi = v.getMissingRangeHi(j).stringValue();
      if (lo !== null && hi !== null && lo === hi) {
        if ((e = writeTag(writer, ctx, "8")) !== ReadStatError.OK) return e;
        if ((e = writeStringField(writer, ctx, lo)) !== ReadStatError.OK) return e;
      }
    }
    return ReadStatError.OK;
  }
}

function emitVariableRecords(writer: Writer, ctx: PorWriteCtx): ReadStatError {
  for (const v of writer.variables) {
    let e = writeTag(writer, ctx, "7");
    if (e !== ReadStatError.OK) return e;
    e = writeDoubleField(writer, ctx, v.type === ReadStatType.STRING ? v.userWidth : 0);
    if (e !== ReadStatError.OK) return e;
    e = writeStringField(writer, ctx, v.name);
    if (e !== ReadStatError.OK) return e;
    const { retval, format } = spssFormatForVariable(v);
    if (retval !== ReadStatError.OK) return retval;
    if ((e = emitFormat(writer, ctx, format)) !== ReadStatError.OK) return e;
    if ((e = emitFormat(writer, ctx, format)) !== ReadStatError.OK) return e;
    if ((e = emitMissingValues(writer, ctx, v)) !== ReadStatError.OK) return e;
    if (v.label) {
      if ((e = writeTag(writer, ctx, "C")) !== ReadStatError.OK) return e;
      if ((e = writeStringField(writer, ctx, v.label)) !== ReadStatError.OK) return e;
    }
  }
  return ReadStatError.OK;
}

function emitValueLabelRecords(writer: Writer, ctx: PorWriteCtx): ReadStatError {
  for (const ls of writer.labelSets) {
    if (ls.valueLabels.length === 0 || ls.variables.length === 0) continue;
    let e = writeTag(writer, ctx, "D");
    if (e !== ReadStatError.OK) return e;
    e = writeDoubleField(writer, ctx, ls.variables.length);
    if (e !== ReadStatError.OK) return e;
    for (const v of ls.variables) {
      if ((e = writeStringField(writer, ctx, v.name)) !== ReadStatError.OK) return e;
    }
    e = writeDoubleField(writer, ctx, ls.valueLabels.length);
    if (e !== ReadStatError.OK) return e;
    for (const vl of ls.valueLabels) {
      if (ls.type === ReadStatType.STRING) {
        e = writeStringField(writer, ctx, vl.stringKey ?? "");
      } else if (ls.type === ReadStatType.DOUBLE) {
        e = writeDoubleField(writer, ctx, vl.doubleKey);
      } else {
        e = writeDoubleField(writer, ctx, vl.int32Key);
      }
      if (e !== ReadStatError.OK) return e;
      if ((e = writeStringField(writer, ctx, vl.label)) !== ReadStatError.OK) return e;
    }
  }
  return ReadStatError.OK;
}

function emitDocumentRecord(writer: Writer, ctx: PorWriteCtx): ReadStatError {
  let e = writeTag(writer, ctx, "E");
  if (e !== ReadStatError.OK) return e;
  e = writeDoubleField(writer, ctx, writer.notes.length);
  if (e !== ReadStatError.OK) return e;
  for (const note of writer.notes) {
    const len = utf8Encoder.encode(note).length;
    if (len > SPSS_DOC_LINE_SIZE) return ReadStatError.ERROR_NOTE_IS_TOO_LONG;
    if ((e = writeStringFieldN(writer, ctx, note, len)) !== ReadStatError.OK) return e;
  }
  return ReadStatError.OK;
}

// ---- value writers ----

function porVariableWidth(type: ReadStatType, userWidth: number): number {
  if (type === ReadStatType.STRING) return POR_BASE30_PRECISION + 4 + userWidth;
  return POR_BASE30_PRECISION + 4;
}

function writeDoubleValue(writer: Writer, offset: number, value: number): ReadStatError {
  const b = encodeDoubleBase30(value, POR_BASE30_PRECISION);
  if (b === null) return ReadStatError.ERROR_WRITE;
  writer.row.set(b, offset);
  return ReadStatError.OK;
}

function writeStringValue(writer: Writer, offset: number, v: Variable, str: string): ReadStatError {
  let s = str;
  let bytes = utf8Encoder.encode(s);
  if (bytes.length === 0) {
    bytes = utf8Encoder.encode(" ");
  }
  let len = bytes.length;
  if (len > v.storageWidth) len = v.storageWidth;
  const lenBytes = encodeDoubleBase30(len, POR_BASE30_PRECISION);
  if (lenBytes === null) return ReadStatError.ERROR_WRITE;
  writer.row.set(lenBytes, offset);
  writer.row.set(bytes.subarray(0, len), offset + lenBytes.length);
  return ReadStatError.OK;
}

function porWriteRow(writer: Writer, row: Uint8Array, rowLen: number): ReadStatError {
  // compact: remove NUL padding between fields
  const compacted = new Uint8Array(rowLen);
  let output = 0;
  for (let offset = 0; offset < rowLen; offset++) {
    if (row[offset]) compacted[output++] = row[offset];
  }
  const ctx = writer.moduleCtx as PorWriteCtx;
  const enc = porEncodeBytes(ctx, compacted.subarray(0, output));
  if (enc === null) return ReadStatError.ERROR_CONVERT;
  return writeAsLines(writer, enc);
}

// ---- name validation ----

function validateVariableName(name: string): ReadStatError {
  if (name.length < 1 || name.length > 8) return ReadStatError.ERROR_NAME_IS_TOO_LONG;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "@" || c === "#" || c === "$" || c === "_" || c === ".") {
      continue;
    }
    return ReadStatError.ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER;
  }
  if (!(name[0] >= "A" && name[0] <= "Z") && name[0] !== "@") {
    return ReadStatError.ERROR_NAME_BEGINS_WITH_ILLEGAL_CHARACTER;
  }
  return ReadStatError.OK;
}

// ---- lifecycle ----

function porBeginData(writer: Writer): ReadStatError {
  const ctx = new PorWriteCtx();
  writer.moduleCtx = ctx;
  const steps: ((w: Writer, c: PorWriteCtx) => ReadStatError)[] = [
    emitHeader,
    emitVersionAndTimestamp,
    emitIdentificationRecords,
    (w, c) => {
      let e = writeTag(w, c, "4");
      if (e !== ReadStatError.OK) return e;
      return writeDoubleField(w, c, w.variables.length);
    },
    (w, c) => {
      let e = writeTag(w, c, "5");
      if (e !== ReadStatError.OK) return e;
      return writeDoubleField(w, c, POR_BASE30_PRECISION);
    },
    (w, c) => {
      if (!w.fweightVariable) return ReadStatError.OK;
      let e = writeTag(w, c, "6");
      if (e !== ReadStatError.OK) return e;
      return writeStringField(w, c, w.fweightVariable.name);
    },
    emitVariableRecords,
    emitValueLabelRecords,
    emitDocumentRecord,
    (w, c) => writeTag(w, c, "F"),
  ];
  for (const step of steps) {
    const e = step(writer, ctx);
    if (e !== ReadStatError.OK) return e;
  }
  return ReadStatError.OK;
}

function porEndData(writer: Writer): ReadStatError {
  const ctx = writer.moduleCtx as PorWriteCtx;
  let e = writeTag(writer, ctx, "Z");
  if (e !== ReadStatError.OK) return e;
  return writer.writeLinePadding(0x5a /* 'Z' */, 80, "\r\n");
}

function metadataOk(writer: Writer): ReadStatError {
  if (writer.compression !== ReadStatCompress.NONE) return ReadStatError.ERROR_UNSUPPORTED_COMPRESSION;
  return ReadStatError.OK;
}

export function beginWritingPor(writer: Writer, userCtx: unknown, rowCount: number): ReadStatError {
  writer.callbacks.metadataOk = metadataOk;
  writer.callbacks.variableWidth = porVariableWidth;
  writer.callbacks.variableOk = (v) => validateVariableName(v.name);
  writer.callbacks.writeInt8 = (w, off, _v, value) => writeDoubleValue(w, off, value);
  writer.callbacks.writeInt16 = (w, off, _v, value) => writeDoubleValue(w, off, value);
  writer.callbacks.writeInt32 = (w, off, _v, value) => writeDoubleValue(w, off, value);
  writer.callbacks.writeFloat = (w, off, _v, value) => writeDoubleValue(w, off, value);
  writer.callbacks.writeDouble = (w, off, _v, value) => writeDoubleValue(w, off, value);
  writer.callbacks.writeString = (w, off, v, value) => writeStringValue(w, off, v, value);
  writer.callbacks.writeMissingString = (w, off) => writeDoubleValue(w, off, 0);
  writer.callbacks.writeMissingNumber = (w, off) => writeDoubleValue(w, off, NaN);
  writer.callbacks.beginData = porBeginData;
  writer.callbacks.writeRow = porWriteRow;
  writer.callbacks.endData = porEndData;
  return writer.beginWritingFile(userCtx, rowCount);
}
