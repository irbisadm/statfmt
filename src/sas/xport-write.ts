//
// sas/xport-write.ts — SAS transport (.xpt) writer (port of readstat_xport_write.c)
//

import { ReadStatError } from "../errors.js";
import { ReadStatType, ReadStatTypeClass, readstatTypeClass, ReadStatAlignment } from "../types.js";
import { Writer, latin1Bytes } from "../writer.js";
import { Variable } from "../variable.js";
import { SAS_COLUMN_TYPE_CHR, SAS_COLUMN_TYPE_NUM, XPORT_MONTHS, sasValidateVariableName, sasValidateName, sasValidateTag } from "./sas.js";
import { xportParseFormat } from "./xport-parse-format.js";
import { doubleToXpt } from "./ieee.js";

const XPORT_DEFAULT_VERSION = 8;
const RECORD_LEN = 80;
const XPORT_MIN_DOUBLE_SIZE = 3;
const XPORT_MAX_DOUBLE_SIZE = 8;

const utf8 = new TextEncoder();

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s.slice(s.length - n) : " ".repeat(n - s.length) + s;
}
function num5(n: number): string {
  return String(n).padStart(5, "0");
}

/** copypad: dst[0..len) = src bytes then spaces. */
function copypad(dst: Uint8Array, off: number, len: number, src: string): void {
  const b = utf8.encode(src);
  let i = 0;
  for (; i < len && i < b.length; i++) dst[off + i] = b[i];
  for (; i < len; i++) dst[off + i] = 0x20;
}

function writeBytes(writer: Writer, bytes: Uint8Array): ReadStatError {
  return writer.writeBytesAsLines(bytes, RECORD_LEN, "");
}
function finishRecord(writer: Writer): ReadStatError {
  return writer.writeLinePadding(0x20, RECORD_LEN, "");
}
function writeRecord(writer: Writer, record: string): ReadStatError {
  const e = writeBytes(writer, latin1Bytes(record));
  if (e !== ReadStatError.OK) return e;
  return finishRecord(writer);
}

interface XportHeaderRec {
  name: string;
  num1?: number;
  num2?: number;
  num3?: number;
  num4?: number;
  num5?: number;
  num6?: number;
}

function writeHeaderRecord(writer: Writer, r: XportHeaderRec): ReadStatError {
  const record =
    "HEADER RECORD*******" +
    padEnd(r.name, 8) +
    "HEADER RECORD!!!!!!!" +
    num5(r.num1 ?? 0) + num5(r.num2 ?? 0) + num5(r.num3 ?? 0) +
    num5(r.num4 ?? 0) + num5(r.num5 ?? 0) + num5(r.num6 ?? 0);
  return writeRecord(writer, record);
}

function xportVariableWidth(type: ReadStatType, userWidth: number): number {
  if (type === ReadStatType.STRING) return userWidth;
  if (userWidth >= XPORT_MAX_DOUBLE_SIZE || userWidth === 0) return XPORT_MAX_DOUBLE_SIZE;
  if (userWidth <= XPORT_MIN_DOUBLE_SIZE) return XPORT_MIN_DOUBLE_SIZE;
  return userWidth;
}

function buildNamestr(writer: Writer, variable: Variable, index: number, offset: number): { buf: Uint8Array; needsLong: boolean; hasLongFormat: boolean } {
  const width = xportVariableWidth(variable.type, variable.userWidth);
  const buf = new Uint8Array(140);
  const dv = new DataView(buf.buffer);
  let needsLong = false;
  let hasLongFormat = false;

  dv.setUint16(0, readstatTypeClass(variable.type) === ReadStatTypeClass.STRING ? SAS_COLUMN_TYPE_CHR : SAS_COLUMN_TYPE_NUM, false); // ntype
  dv.setUint16(4, width, false); // nlng
  dv.setUint16(6, index + 1, false); // nvar0
  copypad(buf, 8, 8, variable.name); // nname
  copypad(buf, 16, 40, variable.label); // nlabel
  copypad(buf, 56, 8, ""); // nform (default spaces)
  copypad(buf, 72, 8, ""); // niform

  if (variable.format && variable.format[0]) {
    const { retval, format } = xportParseFormat(variable.format);
    if (retval === ReadStatError.OK) {
      copypad(buf, 56, 8, format.name);
      dv.setUint16(64, format.width, false); // nfl
      dv.setUint16(66, format.decimals, false); // nfd
      copypad(buf, 72, 8, format.name);
      dv.setUint16(80, format.width, false); // nifl
      dv.setUint16(82, format.decimals, false); // nifd
      if (format.name.length > 8) {
        hasLongFormat = true;
        needsLong = true;
      }
    }
  } else if (variable.displayWidth) {
    dv.setUint16(64, variable.displayWidth, false);
  }

  dv.setUint16(68, variable.alignment === ReadStatAlignment.RIGHT ? 1 : 0, false); // nfj
  dv.setUint32(84, offset, false); // npos

  if (writer.version === 8) {
    copypad(buf, 88, 32, variable.name); // longname
    const labelLen = utf8.encode(variable.label).length;
    if (labelLen > 40) needsLong = true;
    dv.setUint16(120, labelLen, false); // labeln
  }
  return { buf, needsLong, hasLongFormat };
}

function writeVariables(writer: Writer): ReadStatError {
  let offset = 0;
  let numLong = 0;
  let anyLongFormat = false;
  for (let i = 0; i < writer.variables.length; i++) {
    const variable = writer.variables[i];
    const width = xportVariableWidth(variable.type, variable.userWidth);
    const { buf, needsLong, hasLongFormat } = buildNamestr(writer, variable, i, offset);
    if (needsLong) numLong++;
    if (hasLongFormat) anyLongFormat = true;
    offset += width;
    const e = writeBytes(writer, buf);
    if (e !== ReadStatError.OK) return e;
  }
  let e = finishRecord(writer);
  if (e !== ReadStatError.OK) return e;

  if (writer.version === 8 && numLong) {
    const name = anyLongFormat ? "LABELV9" : "LABELV8";
    const record = "HEADER RECORD*******" + padEnd(name, 8) + "HEADER RECORD!!!!!!!" + String(numLong).padEnd(5);
    e = writeRecord(writer, record);
    if (e !== ReadStatError.OK) return e;

    for (let i = 0; i < writer.variables.length; i++) {
      const variable = writer.variables[i];
      const labelLen = utf8.encode(variable.label).length;
      const nameLen = utf8.encode(variable.name).length;
      const formatLen = utf8.encode(variable.format).length;
      let hasLongFormat = false;
      if (variable.format && variable.format[0]) {
        const { retval, format } = xportParseFormat(variable.format);
        if (retval === ReadStatError.OK && format.name.length > 8) hasLongFormat = true;
      }
      const hasLongLabel = labelLen > 40;
      if (hasLongFormat) {
        const def = new Uint8Array(10);
        const ddv = new DataView(def.buffer);
        ddv.setUint16(0, i + 1, false);
        ddv.setUint16(2, nameLen, false);
        ddv.setUint16(4, labelLen, false);
        ddv.setUint16(6, formatLen, false);
        ddv.setUint16(8, formatLen, false);
        if ((e = writer.writeBytes(def)) !== ReadStatError.OK) return e;
        if ((e = writer.writeString(variable.name)) !== ReadStatError.OK) return e;
        if ((e = writer.writeString(variable.label)) !== ReadStatError.OK) return e;
        if ((e = writer.writeString(variable.format)) !== ReadStatError.OK) return e;
        if ((e = writer.writeString(variable.format)) !== ReadStatError.OK) return e;
      } else if (hasLongLabel) {
        const def = new Uint8Array(6);
        const ddv = new DataView(def.buffer);
        ddv.setUint16(0, i + 1, false);
        ddv.setUint16(2, nameLen, false);
        ddv.setUint16(4, labelLen, false);
        if ((e = writer.writeBytes(def)) !== ReadStatError.OK) return e;
        if ((e = writer.writeString(variable.name)) !== ReadStatError.OK) return e;
        if ((e = writer.writeString(variable.label)) !== ReadStatError.OK) return e;
      }
    }
    e = finishRecord(writer);
    if (e !== ReadStatError.OK) return e;
  }
  return ReadStatError.OK;
}

function formatTimestamp(writer: Writer): string {
  const d = new Date(writer.timestamp * 1000);
  const p2 = (n: number) => String(n % 100).padStart(2, "0");
  return `${p2(d.getDate())}${XPORT_MONTHS[d.getMonth()]}${p2(d.getFullYear())}:${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function xportBeginData(writer: Writer): ReadStatError {
  const timestamp = formatTimestamp(writer);
  const dsName = writer.tableName || "DATASET";

  let e = writeHeaderRecord(writer, { name: writer.version === 8 ? "LIBV8" : "LIBRARY" });
  if (e !== ReadStatError.OK) return e;

  e = writeRecord(writer, padEnd("SAS", 8) + padEnd("SAS", 8) + padEnd("SASLIB", 8) + padEnd("6.06", 8) + padEnd("bsd4.2", 8) + padEnd("", 24) + padStart(timestamp, 16));
  if (e !== ReadStatError.OK) return e;

  e = writeRecord(writer, timestamp);
  if (e !== ReadStatError.OK) return e;

  e = writeHeaderRecord(writer, { name: writer.version === 8 ? "MEMBV8" : "MEMBER", num4: 160, num6: 140 });
  if (e !== ReadStatError.OK) return e;

  e = writeHeaderRecord(writer, { name: writer.version === 8 ? "DSCPTV8" : "DSCRPTR" });
  if (e !== ReadStatError.OK) return e;

  if (writer.version === 8) {
    e = writeRecord(writer, padEnd("SAS", 8) + padEnd(dsName, 32) + padEnd("SASDATA", 8) + padEnd("6.06", 8) + padEnd("bsd4.2", 8) + padStart(timestamp, 16));
  } else {
    e = writeRecord(writer, padEnd("SAS", 8) + padEnd(dsName, 8) + padEnd("SASDATA", 8) + padEnd("6.06", 8) + padEnd("bsd4.2", 8) + padEnd("", 24) + padStart(timestamp, 16));
  }
  if (e !== ReadStatError.OK) return e;

  e = writeRecord(writer, padStart(timestamp, 16) + padEnd("", 16) + padEnd(writer.fileLabel, 40) + padEnd("", 8));
  if (e !== ReadStatError.OK) return e;

  e = writeHeaderRecord(writer, { name: writer.version === 8 ? "NAMSTV8" : "NAMESTR", num2: writer.variables.length });
  if (e !== ReadStatError.OK) return e;

  e = writeVariables(writer);
  if (e !== ReadStatError.OK) return e;

  if (writer.version === 8) {
    const record = "HEADER RECORD*******" + padEnd("OBSV8", 8) + "HEADER RECORD!!!!!!!" + String(writer.rowCount).padStart(15);
    e = writeRecord(writer, record);
  } else {
    e = writeHeaderRecord(writer, { name: "OBS" });
  }
  return e;
}

function xportEndData(writer: Writer): ReadStatError {
  return finishRecord(writer);
}

function xportWriteRow(writer: Writer, row: Uint8Array, rowLen: number): ReadStatError {
  return writeBytes(writer, row.subarray(0, rowLen));
}

function writeDoubleValue(writer: Writer, offset: number, variable: Variable, value: number): ReadStatError {
  const xpt = doubleToXpt(value);
  writer.row.set(xpt.subarray(0, variable.storageWidth), offset);
  return ReadStatError.OK;
}

function writeStringValue(writer: Writer, offset: number, variable: Variable, str: string): ReadStatError {
  writer.row.fill(0x20, offset, offset + variable.storageWidth);
  if (str && str.length > 0) {
    const b = utf8.encode(str);
    if (b.length > variable.storageWidth) return ReadStatError.ERROR_STRING_VALUE_IS_TOO_LONG;
    writer.row.set(b, offset);
  }
  return ReadStatError.OK;
}

function metadataOk(writer: Writer): ReadStatError {
  if (writer.version !== 5 && writer.version !== 8) return ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION;
  if (writer.tableName) {
    return sasValidateName(writer.tableName, writer.version === 8 ? 32 : 8);
  }
  return ReadStatError.OK;
}

export function beginWritingXport(writer: Writer, userCtx: unknown, rowCount: number): ReadStatError {
  if (writer.version === 0) writer.version = XPORT_DEFAULT_VERSION;

  writer.callbacks.metadataOk = metadataOk;
  writer.callbacks.variableWidth = xportVariableWidth;
  writer.callbacks.variableOk = (v) => sasValidateVariableName(v.name);
  writer.callbacks.writeInt8 = (w, off, v, value) => writeDoubleValue(w, off, v, value);
  writer.callbacks.writeInt16 = (w, off, v, value) => writeDoubleValue(w, off, v, value);
  writer.callbacks.writeInt32 = (w, off, v, value) => writeDoubleValue(w, off, v, value);
  writer.callbacks.writeFloat = (w, off, v, value) => writeDoubleValue(w, off, v, value);
  writer.callbacks.writeDouble = (w, off, v, value) => writeDoubleValue(w, off, v, value);
  writer.callbacks.writeString = (w, off, v, value) => writeStringValue(w, off, v, value);
  writer.callbacks.writeMissingString = (w, off, v) => writeStringValue(w, off, v, "");
  writer.callbacks.writeMissingNumber = (w, off) => {
    w.row[off] = 0x2e;
    return ReadStatError.OK;
  };
  writer.callbacks.writeMissingTagged = (w, off, _v, tag) => {
    const t = tag.charCodeAt(0);
    const e = sasValidateTag(t);
    if (e === ReadStatError.OK) w.row[off] = t;
    return e;
  };
  writer.callbacks.beginData = xportBeginData;
  writer.callbacks.endData = xportEndData;
  writer.callbacks.writeRow = xportWriteRow;

  return writer.beginWritingFile(userCtx, rowCount);
}
