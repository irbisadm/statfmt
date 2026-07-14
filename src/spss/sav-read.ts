//
// spss/sav-read.ts — SAV reader (port of readstat_sav_read.c)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import {
  ReadStatType,
  ReadStatCompress,
  ReadStatEndian,
  ReadStatMetadata,
  makeEmptyMetadata,
  HandlerStatus,
  ReadStatSeek,
  MrSet,
} from "../types.js";
import { IoContext, ioReadExact, IoReadError } from "../io.js";
import { ReadStatParser } from "../parser.js";
import { Codec, convertString, normalizeEncoding } from "../codec.js";
import { ReadStatValue, makeStringValue, makeDoubleValue } from "../value.js";
import { Variable } from "../variable.js";
import {
  SpssVarinfo,
  makeVarinfo,
  SPSS_FORMAT_TYPE_A,
  SPSS_DOC_LINE_SIZE,
  spssInitVariableForInfo,
  spssMeasureToReadstat,
  spssAlignmentToReadstat,
  SAV_MISSING_DOUBLE,
  SAV_LOWEST_DOUBLE,
  SAV_HIGHEST_DOUBLE,
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
  SAV_RECORD_SUBTYPE_MULTIPLE_RESPONSE_SETS,
  SAV_RECORD_SUBTYPE_VAR_DISPLAY,
  SAV_RECORD_SUBTYPE_LONG_VAR_NAME,
  SAV_RECORD_SUBTYPE_VERY_LONG_STR,
  SAV_RECORD_SUBTYPE_LONG_STRING_VALUE_LABELS,
  SAV_RECORD_SUBTYPE_LONG_STRING_MISSING_VALUES,
} from "./sav.js";
import { SavRowStream, SavRowStreamStatus, savDecompressRow } from "./sav-compress.js";
import { savParseTime, savParseDate, makeTm } from "./sav-parse-timestamp.js";
import { parseMrString } from "./sav-parse-mr.js";

const LABEL_NAME_PREFIX = "labels";
const VERY_LONG_STRING_MAX_LENGTH = 0x7fffffff;

const CHARSET_TABLE: Record<number, string> = {
  1: "EBCDIC-US", 2: "WINDOWS-1252", 3: "WINDOWS-1252", 4: "DEC-KANJI",
  437: "CP437", 708: "ASMO-708", 737: "CP737", 775: "CP775", 850: "CP850",
  852: "CP852", 855: "CP855", 857: "CP857", 858: "CP858", 860: "CP860",
  861: "CP861", 862: "CP862", 863: "CP863", 864: "CP864", 865: "CP865",
  866: "CP866", 869: "CP869", 874: "CP874", 932: "CP932", 936: "CP936",
  949: "CP949", 950: "BIG-5", 1200: "UTF-16LE", 1201: "UTF-16BE",
  1250: "WINDOWS-1250", 1251: "WINDOWS-1251", 1252: "WINDOWS-1252",
  1253: "WINDOWS-1253", 1254: "WINDOWS-1254", 1255: "WINDOWS-1255",
  1256: "WINDOWS-1256", 1257: "WINDOWS-1257", 1258: "WINDOWS-1258",
  1361: "CP1361", 10000: "MACROMAN", 10004: "MACARABIC", 10005: "MACHEBREW",
  10006: "MACGREEK", 10007: "MACCYRILLIC", 10010: "MACROMANIA",
  10017: "MACUKRAINE", 10021: "MACTHAI", 10029: "MACCENTRALEUROPE",
  10079: "MACICELAND", 10081: "MACTURKISH", 10082: "MACCROATIAN",
  12000: "UTF-32LE", 12001: "UTF-32BE", 20127: "US-ASCII", 20866: "KOI8-R",
  20932: "EUC-JP", 21866: "KOI8-U", 28591: "ISO-8859-1", 28592: "ISO-8859-2",
  28593: "ISO-8859-3", 28594: "ISO-8859-4", 28595: "ISO-8859-5",
  28596: "ISO-8859-6", 28597: "ISO-8859-7", 28598: "ISO-8859-8",
  28599: "ISO-8859-9", 28603: "ISO-8859-13", 28605: "ISO-8859-15",
  50220: "ISO-2022-JP", 50221: "ISO-2022-JP", 50222: "ISO-2022-JP",
  50225: "ISO-2022-KR", 50229: "ISO-2022-CN", 51932: "EUC-JP", 51936: "GBK",
  51949: "EUC-KR", 52936: "HZ-GB-2312", 54936: "GB18030", 65000: "UTF-7",
  65001: "UTF-8",
};

interface ValueLabelTmp {
  rawValue: Uint8Array; // 8 bytes
  finalValue: ReadStatValue;
  label: string;
}

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

class SavReadCtx {
  io: IoContext;
  parser: ReadStatParser;
  codec: Codec;
  userCtx: unknown;
  le: boolean;
  fileSize: number;

  formatVersion = 0;
  compression: ReadStatCompress = ReadStatCompress.NONE;
  endianness: ReadStatEndian = ReadStatEndian.NONE;
  recordCount = 0;
  fweightIndex = 0;
  bias = 100;

  missingDouble = SAV_MISSING_DOUBLE;
  lowestDouble = SAV_LOWEST_DOUBLE;
  highestDouble = SAV_HIGHEST_DOUBLE;

  srcEncoding: string | null = null;

  varinfo: SpssVarinfo[] = [];
  varIndex = 0;
  varOffset = 0;
  varCount = 0;
  variables: (Variable | null)[] = [];
  variableSkip: boolean[] = [];

  valueLabelsCount = 0;
  variableDisplayValues: number[] = [];

  rowLimit = -1;
  rowOffset = 0;
  currentRow = 0;
  timestamp = 0;
  fileLabel: string | null = null;

  mrSets: MrSet[] | null = null;

  // scratch for row processing
  rawString!: Uint8Array;
  rawStringLen = 0;
  utf8StringConsumer = "";

  private offsetMap: Map<number, SpssVarinfo> | null = null;

  constructor(io: IoContext, parser: ReadStatParser, userCtx: unknown, le: boolean, fileSize: number) {
    this.io = io;
    this.parser = parser;
    this.codec = parser.codec;
    this.userCtx = userCtx;
    this.le = le;
    this.fileSize = fileSize;
    this.srcEncoding = parser.inputEncoding;
  }

  conv(bytes: Uint8Array, off = 0, len = bytes.length - off): string {
    return convertString(this.codec, bytes, this.srcEncoding ?? "utf-8", off, len);
  }

  // ---- low-level reads ----
  bytes(n: number): Uint8Array {
    return ioReadExact(this.io, n);
  }
  u32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, this.le);
  }
  i32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getInt32(0, this.le);
  }
  u64FromBytes(b: Uint8Array, off = 0): bigint {
    return new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, this.le);
  }
  f64FromBytes(b: Uint8Array, off = 0): number {
    return new DataView(b.buffer, b.byteOffset + off, 8).getFloat64(0, this.le);
  }
  seekCur(n: number): void {
    if (this.io.seek(n, ReadStatSeek.CUR) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
  }
  seekSet(n: number): void {
    if (this.io.seek(n, ReadStatSeek.SET) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
  }

  offsetLookup(off: number): SpssVarinfo | undefined {
    if (!this.offsetMap) {
      this.offsetMap = new Map();
      for (let i = 0; i < this.varIndex; i++) this.offsetMap.set(this.varinfo[i].offset, this.varinfo[i]);
    }
    return this.offsetMap.get(off);
  }
}

function tagMissingDouble(value: ReadStatValue, ctx: SavReadCtx): void {
  const fp = value.num;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, fp, true);
  const bits = dv.getBigUint64(0, true);
  if (bits === ctx.missingDouble) value.isSystemMissing = true;
  if (bits === ctx.lowestDouble) value.isSystemMissing = true;
  if (bits === ctx.highestDouble) value.isSystemMissing = true;
  if (Number.isNaN(fp)) value.isSystemMissing = true;
}

// ---- pass 1: skip records, harvest encoding / MR sets ----

function stripRaw(b: Uint8Array): Uint8Array {
  let len = b.length;
  while (len > 0 && (b[len - 1] === 0x20 || b[len - 1] === 0x00)) len--;
  return b.slice(0, len);
}

function skipVariableRecord(ctx: SavReadCtx): void {
  const rec = ctx.bytes(28);
  const dv = new DataView(rec.buffer, rec.byteOffset, 28);
  const hasVarLabel = dv.getInt32(4, ctx.le);
  const nMissing = dv.getInt32(8, ctx.le);
  if (hasVarLabel) {
    const labelLen = ctx.u32();
    const cap = Math.floor((labelLen + 3) / 4) * 4;
    ctx.seekCur(cap);
  }
  if (nMissing) {
    ctx.seekCur(Math.abs(nMissing) * 8);
  }
}

function skipValueLabelRecord(ctx: SavReadCtx): void {
  const labelCount = ctx.u32();
  for (let i = 0; i < labelCount; i++) {
    ctx.seekCur(8);
    const unpadded = ctx.bytes(1)[0];
    const padded = Math.floor((unpadded + 8) / 8) * 8 - 1;
    ctx.seekCur(padded);
  }
  const recType = ctx.i32();
  if (recType !== SAV_RECORD_TYPE_VALUE_LABEL_VARIABLES) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const varCount = ctx.u32();
  ctx.seekCur(varCount * 4);
}

function skipDocumentRecord(ctx: SavReadCtx): void {
  const nLines = ctx.u32();
  ctx.seekCur(nLines * SPSS_DOC_LINE_SIZE);
}

function readMultipleResponseSets(ctx: SavReadCtx, dataLen: number): void {
  const data = ctx.bytes(dataLen);
  if (data[0] !== 0x24) throw new ReadStatException(ReadStatError.ERROR_BAD_MR_STRING);
  ctx.mrSets = parseMrString(data, (b, off, len) => ctx.conv(b, off, len));
}

function parseMachineIntegerInfoRecord(ctx: SavReadCtx, data: Uint8Array): void {
  if (data.length !== 32) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const dv = new DataView(data.buffer, data.byteOffset, 32);
  const characterCode = dv.getInt32(28, ctx.le);
  if (!ctx.srcEncoding) {
    const name = CHARSET_TABLE[characterCode];
    if (!name) {
      if (ctx.parser.handlers.error) {
        ctx.parser.handlers.error(`Unsupported character set: ${characterCode}\n`, ctx.userCtx);
      }
      throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_CHARSET);
    }
    ctx.srcEncoding = name;
  }
}

function pass1(ctx: SavReadCtx): void {
  for (;;) {
    let recType: number;
    try {
      recType = ctx.u32();
    } catch (e) {
      if (e instanceof IoReadError) throw new ReadStatException(ReadStatError.ERROR_READ);
      throw e;
    }
    switch (recType) {
      case SAV_RECORD_TYPE_VARIABLE:
        skipVariableRecord(ctx);
        break;
      case SAV_RECORD_TYPE_VALUE_LABEL:
        skipValueLabelRecord(ctx);
        break;
      case SAV_RECORD_TYPE_DOCUMENT:
        skipDocumentRecord(ctx);
        break;
      case SAV_RECORD_TYPE_DICT_TERMINATION:
        return;
      case SAV_RECORD_TYPE_HAS_DATA: {
        const extra = ctx.bytes(12);
        const dv = new DataView(extra.buffer, extra.byteOffset, 12);
        const subtype = dv.getUint32(0, ctx.le);
        const size = dv.getUint32(4, ctx.le);
        const count = dv.getUint32(8, ctx.le);
        const dataLen = size * count;
        if (subtype === SAV_RECORD_SUBTYPE_INTEGER_INFO) {
          const data = ctx.bytes(dataLen);
          parseMachineIntegerInfoRecord(ctx, data);
        } else if (subtype === SAV_RECORD_SUBTYPE_MULTIPLE_RESPONSE_SETS) {
          if (ctx.mrSets !== null) throw new ReadStatException(ReadStatError.ERROR_BAD_MR_STRING);
          readMultipleResponseSets(ctx, dataLen);
        } else {
          ctx.seekCur(dataLen);
        }
        break;
      }
      default:
        throw new ReadStatException(ReadStatError.ERROR_PARSE);
    }
  }
}

// ---- pass 2: read records fully ----

function readVariableLabel(info: SpssVarinfo, ctx: SavReadCtx): void {
  const labelLen = ctx.u32();
  if (labelLen === 0) return;
  const cap = Math.floor((labelLen + 3) / 4) * 4;
  const buf = ctx.bytes(cap);
  info.label = ctx.conv(buf, 0, labelLen);
}

function readVariableMissingDoubleValues(info: SpssVarinfo, ctx: SavReadCtx): void {
  const n = info.nMissingValues;
  const buf = ctx.bytes(n * 8);
  for (let i = 0; i < n; i++) {
    let val = ctx.f64FromBytes(buf, i * 8);
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, val, true);
    const bits = dv.getBigUint64(0, true);
    if (bits === ctx.missingDouble) val = NaN;
    if (bits === ctx.lowestDouble) val = -Infinity;
    if (bits === ctx.highestDouble) val = Infinity;
    info.missingDoubleValues[i] = val;
  }
}

function readVariableMissingStringValues(info: SpssVarinfo, ctx: SavReadCtx): void {
  for (let i = 0; i < info.nMissingValues; i++) {
    const mv = ctx.bytes(8);
    info.missingStringValues[i] = ctx.conv(mv, 0, 8);
  }
}

function readVariableMissingValues(info: SpssVarinfo, ctx: SavReadCtx): void {
  if (info.nMissingValues > 3 || info.nMissingValues < -3) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (info.nMissingValues < 0) {
    info.missingRange = 1;
    info.nMissingValues = Math.abs(info.nMissingValues);
  } else {
    info.missingRange = 0;
  }
  if (info.type === ReadStatType.DOUBLE) {
    readVariableMissingDoubleValues(info, ctx);
  } else {
    readVariableMissingStringValues(info, ctx);
  }
}

function readVariableRecord(ctx: SavReadCtx): void {
  const rec = ctx.bytes(28);
  const dv = new DataView(rec.buffer, rec.byteOffset, 28);
  const type = dv.getInt32(0, ctx.le);
  const hasVarLabel = dv.getInt32(4, ctx.le);
  const nMissing = dv.getInt32(8, ctx.le);
  const print = dv.getInt32(12, ctx.le);
  const write = dv.getInt32(16, ctx.le);
  const nameBytes = rec.subarray(20, 28);

  if (type < 0) {
    if (ctx.varIndex === 0) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    ctx.varOffset++;
    ctx.varinfo[ctx.varIndex - 1].width++;
    return;
  }

  const info = makeVarinfo();
  info.width = 1;
  info.nSegments = 1;
  info.index = ctx.varIndex;
  info.offset = ctx.varOffset;
  info.labelsIndex = -1;
  info.name = stripRaw(nameBytes);
  info.longname = stripRaw(nameBytes);

  info.printFormat.decimalPlaces = print & 0xff;
  info.printFormat.width = (print >> 8) & 0xff;
  info.printFormat.type = (print >> 16) & 0xff;
  info.writeFormat.decimalPlaces = write & 0xff;
  info.writeFormat.width = (write >> 8) & 0xff;
  info.writeFormat.type = (write >> 16) & 0xff;

  if (type > 0 || info.printFormat.type === SPSS_FORMAT_TYPE_A || info.writeFormat.type === SPSS_FORMAT_TYPE_A) {
    info.type = ReadStatType.STRING;
  } else {
    info.type = ReadStatType.DOUBLE;
  }

  if (hasVarLabel) readVariableLabel(info, ctx);

  if (nMissing) {
    info.nMissingValues = nMissing;
    readVariableMissingValues(info, ctx);
  }

  ctx.varinfo[ctx.varIndex] = info;
  ctx.varIndex++;
  ctx.varOffset++;
}

function submitValueLabels(labels: ValueLabelTmp[], ctx: SavReadCtx): void {
  const name = LABEL_NAME_PREFIX + ctx.valueLabelsCount;
  const h = ctx.parser.handlers.valueLabel;
  if (!h) return;
  for (const vl of labels) {
    if (hstatus(h(name, vl.finalValue, vl.label, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }
}

function readValueLabelRecord(ctx: SavReadCtx): void {
  const labelCount = ctx.u32();
  let valueType = ReadStatType.STRING;
  const labels: ValueLabelTmp[] = [];

  for (let i = 0; i < labelCount; i++) {
    const rawValue = ctx.bytes(8);
    const unpadded = ctx.bytes(1)[0];
    const paddedLen = Math.floor((unpadded + 8) / 8) * 8 - 1;
    const labelBuf = ctx.bytes(paddedLen);
    const label = ctx.conv(labelBuf, 0, paddedLen);
    labels.push({ rawValue, finalValue: new ReadStatValue(ReadStatType.STRING), label });
  }

  const recType = ctx.i32();
  if (recType !== SAV_RECORD_TYPE_VALUE_LABEL_VARIABLES) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const varCount = ctx.u32();
  const varsBuf = ctx.bytes(varCount * 4);
  const vdv = new DataView(varsBuf.buffer, varsBuf.byteOffset, varsBuf.byteLength);
  for (let i = 0; i < varCount; i++) {
    let varOffset = vdv.getUint32(i * 4, ctx.le);
    varOffset--;
    const info = ctx.offsetLookup(varOffset);
    if (info) {
      info.labelsIndex = ctx.valueLabelsCount;
      valueType = info.type;
    }
  }

  for (const vl of labels) {
    vl.finalValue = new ReadStatValue(valueType);
    if (valueType === ReadStatType.DOUBLE) {
      const d = ctx.f64FromBytes(vl.rawValue, 0);
      vl.finalValue.num = d;
      tagMissingDouble(vl.finalValue, ctx);
    } else {
      vl.finalValue.type = ReadStatType.STRING;
      vl.finalValue.str = ctx.conv(vl.rawValue, 0, 8);
    }
  }

  if (ctx.parser.handlers.valueLabel) submitValueLabels(labels, ctx);
  ctx.valueLabelsCount++;
}

function readDocumentRecord(ctx: SavReadCtx): void {
  if (!ctx.parser.handlers.note) {
    skipDocumentRecord(ctx);
    return;
  }
  const nLines = ctx.u32();
  for (let i = 0; i < nLines; i++) {
    const raw = ctx.bytes(SPSS_DOC_LINE_SIZE);
    const note = ctx.conv(raw, 0, SPSS_DOC_LINE_SIZE);
    if (hstatus(ctx.parser.handlers.note(i, note, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }
}

function parseFloatingPointRecord(ctx: SavReadCtx, data: Uint8Array, size: number, count: number): void {
  if (size !== 8 || count !== 3) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.missingDouble = ctx.u64FromBytes(data, 0);
  ctx.highestDouble = ctx.u64FromBytes(data, 8);
  ctx.lowestDouble = ctx.u64FromBytes(data, 16);
}

function storeVariableDisplayRecord(ctx: SavReadCtx, data: Uint8Array, size: number, count: number): void {
  if (size !== 4) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  ctx.variableDisplayValues = [];
  for (let i = 0; i < count; i++) ctx.variableDisplayValues.push(dv.getUint32(i * 4, ctx.le));
}

function parseVariableDisplayParameterRecord(ctx: SavReadCtx): void {
  if (ctx.variableDisplayValues.length === 0) return;
  const count = ctx.variableDisplayValues.length;
  if (count !== 2 * ctx.varIndex && count !== 3 * ctx.varIndex) {
    throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
  const hasDisplayWidth = ctx.varIndex > 0 && Math.floor(count / ctx.varIndex) === 3;
  for (let i = 0; i < ctx.varIndex; ) {
    const info = ctx.varinfo[i];
    let offset = (2 + (hasDisplayWidth ? 1 : 0)) * i;
    info.measure = spssMeasureToReadstat(ctx.variableDisplayValues[offset++]);
    if (hasDisplayWidth) info.displayWidth = ctx.variableDisplayValues[offset++];
    info.alignment = spssAlignmentToReadstat(ctx.variableDisplayValues[offset++]);
    i += info.nSegments;
  }
}

// long-name / very-long-string helpers work off raw (latin1) name bytes
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function parseLongVariableNamesRecord(ctx: SavReadCtx, data: Uint8Array): void {
  // data is "KEY=VALUE\tKEY=VALUE..."
  const text = latin1(data);
  const pairs = text.split("\t");
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toUpperCase();
    let val = pair.slice(eq + 1);
    if (val.length > 64) val = val.slice(0, 64);
    const valBytes = new Uint8Array(val.length);
    for (let k = 0; k < val.length; k++) valBytes[k] = val.charCodeAt(k) & 0xff;
    for (let i = 0; i < ctx.varIndex; i++) {
      const info = ctx.varinfo[i];
      if (latin1(info.name).toUpperCase() === key) {
        info.longname = valBytes;
      }
    }
  }
}

function parseVeryLongStringRecord(ctx: SavReadCtx, data: Uint8Array): void {
  const text = latin1(data);
  // "KEY=NNN\0\tKEY=NNN..." — split on tab, strip NULs
  const pairs = text.split("\t");
  for (const rawPair of pairs) {
    const pair = rawPair.replace(/\0/g, "");
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toUpperCase();
    const width = parseInt(pair.slice(eq + 1), 10);
    if (!Number.isFinite(width)) continue;
    for (let i = 0; i < ctx.varIndex; i++) {
      const info = ctx.varinfo[i];
      if (latin1(info.name).toUpperCase() === key) {
        info.stringLength = width;
        info.writeFormat.width = width;
        info.printFormat.width = width;
      }
    }
  }
}

function findByLongname(ctx: SavReadCtx, longnameRaw: string): SpssVarinfo | null {
  for (let i = 0; i < ctx.varIndex; i++) {
    if (latin1(ctx.varinfo[i].longname) === longnameRaw) return ctx.varinfo[i];
  }
  return null;
}

function readPascalString(dv: DataView, data: Uint8Array, pos: { p: number }, le: boolean): Uint8Array {
  if (pos.p + 4 > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const len = dv.getUint32(pos.p, le);
  pos.p += 4;
  if (pos.p + len > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const out = data.subarray(pos.p, pos.p + len);
  pos.p += len;
  return out;
}

function parseLongStringValueLabelsRecord(ctx: SavReadCtx, data: Uint8Array, size: number): void {
  if (!ctx.parser.handlers.valueLabel) return;
  if (size !== 1) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pos = { p: 0 };
  while (pos.p < data.length) {
    const varNameRaw = readPascalString(dv, data, pos, ctx.le);
    const info = findByLongname(ctx, latin1(varNameRaw));
    let labelName: string | null = null;
    if (info) {
      info.labelsIndex = ctx.valueLabelsCount++;
      labelName = LABEL_NAME_PREFIX + info.labelsIndex;
    }
    if (labelName === null) throw new ReadStatException(ReadStatError.ERROR_PARSE);

    pos.p += 4; // variable width
    if (pos.p + 4 > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const labelCount = dv.getUint32(pos.p, ctx.le);
    pos.p += 4;

    for (let i = 0; i < labelCount; i++) {
      if (pos.p + 4 > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      const valueLen = dv.getUint32(pos.p, ctx.le);
      pos.p += 4;
      if (pos.p + valueLen > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      const valueStr = ctx.conv(data, pos.p, valueLen);
      pos.p += valueLen;

      if (pos.p + 4 > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      const labelLen = dv.getUint32(pos.p, ctx.le);
      pos.p += 4;
      if (pos.p + labelLen > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      const labelStr = ctx.conv(data, pos.p, labelLen);
      pos.p += labelLen;

      const value = makeStringValue(valueStr);
      if (hstatus(ctx.parser.handlers.valueLabel(labelName, value, labelStr, ctx.userCtx)) !== HandlerStatus.OK) {
        throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      }
    }
  }
  if (pos.p !== data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
}

function parseLongStringMissingValuesRecord(ctx: SavReadCtx, data: Uint8Array, size: number): void {
  if (size !== 1) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pos = { p: 0 };
  while (pos.p < data.length) {
    const varNameRaw = readPascalString(dv, data, pos, ctx.le);
    if (pos.p === data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const nMissing = data[pos.p++];
    if (nMissing < 1 || nMissing > 3) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const info = findByLongname(ctx, latin1(varNameRaw));
    if (!info) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    info.nMissingValues = nMissing;
    if (pos.p + 4 > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const valueLen = dv.getUint32(pos.p, ctx.le);
    pos.p += 4;
    for (let j = 0; j < nMissing; j++) {
      if (pos.p + valueLen > data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      info.missingStringValues[j] = ctx.conv(data, pos.p, valueLen);
      pos.p += valueLen;
    }
  }
  if (pos.p !== data.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
}

function pass2(ctx: SavReadCtx): void {
  for (;;) {
    let recType: number;
    try {
      recType = ctx.u32();
    } catch (e) {
      if (e instanceof IoReadError) throw new ReadStatException(ReadStatError.ERROR_READ);
      throw e;
    }
    switch (recType) {
      case SAV_RECORD_TYPE_VARIABLE:
        readVariableRecord(ctx);
        break;
      case SAV_RECORD_TYPE_VALUE_LABEL:
        readValueLabelRecord(ctx);
        break;
      case SAV_RECORD_TYPE_DOCUMENT:
        readDocumentRecord(ctx);
        break;
      case SAV_RECORD_TYPE_DICT_TERMINATION:
        ctx.bytes(4); // filler
        return;
      case SAV_RECORD_TYPE_HAS_DATA: {
        const extra = ctx.bytes(12);
        const dv = new DataView(extra.buffer, extra.byteOffset, 12);
        const subtype = dv.getUint32(0, ctx.le);
        const size = dv.getUint32(4, ctx.le);
        const count = dv.getUint32(8, ctx.le);
        const dataLen = size * count;
        if (dataLen === 0) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        const data = ctx.bytes(dataLen);
        switch (subtype) {
          case SAV_RECORD_SUBTYPE_INTEGER_INFO:
            break; // parsed in pass 1
          case SAV_RECORD_SUBTYPE_FP_INFO:
            parseFloatingPointRecord(ctx, data, size, count);
            break;
          case SAV_RECORD_SUBTYPE_VAR_DISPLAY:
            storeVariableDisplayRecord(ctx, data, size, count);
            break;
          case SAV_RECORD_SUBTYPE_LONG_VAR_NAME:
            parseLongVariableNamesRecord(ctx, data);
            break;
          case SAV_RECORD_SUBTYPE_VERY_LONG_STR:
            parseVeryLongStringRecord(ctx, data);
            break;
          case SAV_RECORD_SUBTYPE_LONG_STRING_VALUE_LABELS:
            parseLongStringValueLabelsRecord(ctx, data, size);
            break;
          case SAV_RECORD_SUBTYPE_LONG_STRING_MISSING_VALUES:
            parseLongStringMissingValuesRecord(ctx, data, size);
            break;
          default:
            break;
        }
        break;
      }
      default:
        throw new ReadStatException(ReadStatError.ERROR_PARSE);
    }
  }
}

function setNSegmentsAndVarCount(ctx: SavReadCtx): void {
  ctx.varCount = 0;
  for (let i = 0; i < ctx.varIndex; ) {
    const info = ctx.varinfo[i];
    if (info.stringLength > VERY_LONG_STRING_MAX_LENGTH) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    if (info.stringLength) {
      info.nSegments = Math.floor((info.stringLength + 251) / 252);
    }
    info.index = ctx.varCount++;
    i += info.nSegments;
  }
  ctx.variables = new Array(ctx.varCount).fill(null);
  ctx.variableSkip = new Array(ctx.varCount).fill(false);
}

function handleVariables(ctx: SavReadCtx): void {
  if (!ctx.parser.handlers.variable) return;
  let indexAfterSkipping = 0;
  for (let i = 0; i < ctx.varIndex; ) {
    const info = ctx.varinfo[i];
    const variable = spssInitVariableForInfo(info, indexAfterSkipping, ctx.codec, ctx.srcEncoding ?? "utf-8");
    ctx.variables[info.index] = variable;
    const valLabels = info.labelsIndex === -1 ? null : LABEL_NAME_PREFIX + info.labelsIndex;
    const cb = hstatus(ctx.parser.handlers.variable(info.index, variable, valLabels, ctx.userCtx));
    if (cb === HandlerStatus.ABORT) throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    if (cb === HandlerStatus.SKIP_VARIABLE) {
      ctx.variableSkip[info.index] = true;
      variable.skip = 1;
    } else {
      indexAfterSkipping++;
    }
    i += info.nSegments;
  }
}

function handleFweight(ctx: SavReadCtx): void {
  if (!ctx.parser.handlers.fweight || ctx.fweightIndex < 0) return;
  for (let i = 0; i < ctx.varIndex; ) {
    const info = ctx.varinfo[i];
    if (info.offset === ctx.fweightIndex - 1) {
      const v = ctx.variables[info.index];
      if (v && hstatus(ctx.parser.handlers.fweight(v, ctx.userCtx)) !== HandlerStatus.OK) {
        throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      }
      return;
    }
    i += info.nSegments;
  }
}

function processRow(ctx: SavReadCtx, buffer: Uint8Array): void {
  if (ctx.rowOffset) {
    ctx.rowOffset--;
    return;
  }
  const bufferLen = buffer.length;
  let offset = 0;
  let dataOffset = 0;
  let rawStrUsed = 0;
  let segmentOffset = 0;
  let varIndex = 0;
  let col = 0;
  const rawStrIsUtf8 = ctx.srcEncoding !== null && normalizeEncoding(ctx.srcEncoding) === "utf-8";
  const valueHandler = ctx.parser.handlers.value!;

  while (dataOffset < bufferLen && col < ctx.varIndex && varIndex < ctx.varIndex) {
    const colInfo = ctx.varinfo[col];
    const varInfo = ctx.varinfo[varIndex];
    if (offset > 31) throw new ReadStatException(ReadStatError.ERROR_PARSE);

    if (varInfo.type === ReadStatType.STRING) {
      const readLen = 8 - (offset === 31 ? 1 : 0);
      if (rawStrUsed + readLen <= ctx.rawStringLen) {
        if (rawStrIsUtf8) {
          for (let k = 0; k < readLen; k++) {
            const c = buffer[dataOffset + k];
            if (c) ctx.rawString[rawStrUsed++] = c;
          }
        } else {
          ctx.rawString.set(buffer.subarray(dataOffset, dataOffset + readLen), rawStrUsed);
          rawStrUsed += readLen;
        }
      }
      if (++offset === colInfo.width) {
        offset = 0;
        col++;
        segmentOffset++;
      }
      if (segmentOffset === varInfo.nSegments) {
        const variable = ctx.variables[varInfo.index]!;
        if (!variable.skip) {
          const str = ctx.conv(ctx.rawString, 0, rawStrUsed);
          const value = makeStringValue(str);
          if (hstatus(valueHandler(ctx.currentRow, variable, value, ctx.userCtx)) !== HandlerStatus.OK) {
            throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
          }
        }
        rawStrUsed = 0;
        segmentOffset = 0;
        varIndex += varInfo.nSegments;
      }
    } else {
      // DOUBLE
      const variable = ctx.variables[varInfo.index]!;
      if (!variable.skip) {
        const fp = ctx.f64FromBytes(buffer, dataOffset);
        const value = makeDoubleValue(fp);
        value.isSystemMissing = false;
        value.num = fp;
        tagMissingDouble(value, ctx);
        if (hstatus(valueHandler(ctx.currentRow, variable, value, ctx.userCtx)) !== HandlerStatus.OK) {
          throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
        }
      }
      varIndex += varInfo.nSegments;
      col++;
    }
    dataOffset += 8;
  }
  ctx.currentRow++;
}

function readUncompressedData(ctx: SavReadCtx): void {
  const bufferLen = ctx.varOffset * 8;
  if (ctx.rowOffset) {
    ctx.seekCur(bufferLen * ctx.rowOffset);
    ctx.rowOffset = 0;
  }
  while (ctx.rowLimit === -1 || ctx.currentRow < ctx.rowLimit) {
    const buffer = ctx.io.read(bufferLen);
    if (buffer.length !== bufferLen) return;
    processRow(ctx, buffer.slice());
  }
}

function readCompressedData(ctx: SavReadCtx): void {
  const DATA_BUFFER_SIZE = 65536;
  const uncompressedRowLen = ctx.varOffset * 8;
  const uncompressedRow = new Uint8Array(uncompressedRowLen);
  let uncompressedOffset = 0;

  const state = new SavRowStream(ctx.missingDouble, ctx.bias, ctx.le);
  state.setOutput(uncompressedRow);

  for (;;) {
    const buffer = ctx.io.read(DATA_BUFFER_SIZE);
    const bufferUsed = buffer.length;
    if (bufferUsed === 0 || bufferUsed % 8 !== 0) return;

    state.status = SavRowStreamStatus.HAVE_DATA;
    let dataOffset = 0;
    while ((state.status as SavRowStreamStatus) !== SavRowStreamStatus.NEED_DATA) {
      state.setInput(buffer.subarray(dataOffset));
      state.out = uncompressedRow;
      state.outPos = uncompressedOffset;
      state.avail_out = uncompressedRowLen - uncompressedOffset;

      savDecompressRow(state);

      uncompressedOffset = state.outPos;
      dataOffset = bufferUsed - state.avail_in;

      if ((state.status as SavRowStreamStatus) === SavRowStreamStatus.FINISHED_ROW) {
        processRow(ctx, uncompressedRow.slice());
        uncompressedOffset = 0;
      }
      if ((state.status as SavRowStreamStatus) === SavRowStreamStatus.FINISHED_ALL) return;
      if (ctx.rowLimit > 0 && ctx.currentRow === ctx.rowLimit) return;
    }
  }
}

function readData(ctx: SavReadCtx): void {
  let longestString = 256;
  for (let i = 0; i < ctx.varIndex; ) {
    const info = ctx.varinfo[i];
    if (info.stringLength > longestString) longestString = info.stringLength;
    i += info.nSegments;
  }
  ctx.rawStringLen = longestString + 8 - 1;
  ctx.rawString = new Uint8Array(ctx.rawStringLen);

  if (ctx.compression === ReadStatCompress.ROWS) {
    readCompressedData(ctx);
  } else if (ctx.compression === ReadStatCompress.BINARY) {
    throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_COMPRESSION);
  } else {
    readUncompressedData(ctx);
  }

  if (ctx.recordCount >= 0 && ctx.currentRow !== ctx.rowLimit) {
    throw new ReadStatException(ReadStatError.ERROR_ROW_COUNT_MISMATCH);
  }
}

function parseTimestamp(ctx: SavReadCtx, creationDate: string, creationTime: string): void {
  const tm = makeTm();
  if (savParseTime(creationTime, tm) !== ReadStatError.OK) return;
  if (savParseDate(creationDate, tm) !== ReadStatError.OK) return;
  // mktime: local time
  const d = new Date(tm.tm_year + 1900, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
  ctx.timestamp = Math.floor(d.getTime() / 1000);
}

/** Parse a SAV/ZSAV file from an IO context. Returns the terminal error code. */
export function parseSav(parser: ReadStatParser, io: IoContext, userCtx: unknown): ReadStatError {
  try {
    const fileSize = io.seek(0, ReadStatSeek.END);
    if (fileSize === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
    io.seek(0, ReadStatSeek.SET);

    const header = ioReadExact(io, 176);
    const dv = new DataView(header.buffer, header.byteOffset, 176);
    const recType = String.fromCharCode(header[0], header[1], header[2], header[3]);
    let formatVersion = 0;
    if (recType === "$FL2") formatVersion = 2;
    else if (recType === "$FL3") formatVersion = 3;
    else return ReadStatError.ERROR_PARSE;

    // determine endianness from layout_code (offset 64)
    let le = true;
    const layoutLE = dv.getInt32(64, true);
    if (layoutLE === 2 || layoutLE === 3) {
      le = true;
    } else {
      const layoutBE = dv.getInt32(64, false);
      if (layoutBE === 2 || layoutBE === 3) le = false;
      else return ReadStatError.ERROR_PARSE;
    }

    const ctx = new SavReadCtx(io, parser, userCtx, le, fileSize);
    ctx.formatVersion = formatVersion;
    ctx.endianness = le ? ReadStatEndian.LITTLE : ReadStatEndian.BIG;
    const compression = dv.getInt32(72, le);
    if (compression === 1) ctx.compression = ReadStatCompress.ROWS;
    else if (compression === 2) ctx.compression = ReadStatCompress.BINARY;
    ctx.fweightIndex = dv.getInt32(76, le);
    ctx.recordCount = dv.getInt32(80, le);
    ctx.bias = dv.getFloat64(84, le);

    const creationDate = latin1(header.subarray(92, 101));
    const creationTime = latin1(header.subarray(101, 109));

    // row offset / limit
    if (parser.rowOffset > 0) ctx.rowOffset = parser.rowOffset;
    if (ctx.recordCount >= 0) {
      let recordCountAfterSkipping = ctx.recordCount - ctx.rowOffset;
      if (recordCountAfterSkipping < 0) {
        recordCountAfterSkipping = 0;
        ctx.rowOffset = ctx.recordCount;
      }
      ctx.rowLimit = recordCountAfterSkipping;
      if (parser.rowLimit > 0 && parser.rowLimit < recordCountAfterSkipping) ctx.rowLimit = parser.rowLimit;
    } else if (parser.rowLimit > 0) {
      ctx.rowLimit = parser.rowLimit;
    }

    parseTimestamp(ctx, creationDate, creationTime);

    pass1(ctx);
    ctx.seekSet(176);
    pass2(ctx);

    setNSegmentsAndVarCount(ctx);
    if (ctx.varCount === 0) return ReadStatError.ERROR_PARSE;

    if (parser.handlers.metadata) {
      const metadata: ReadStatMetadata = makeEmptyMetadata();
      metadata.rowCount = ctx.recordCount < 0 ? -1 : ctx.rowLimit;
      metadata.varCount = ctx.varCount;
      metadata.fileEncoding = ctx.srcEncoding;
      metadata.fileFormatVersion = ctx.formatVersion;
      metadata.creationTime = ctx.timestamp;
      metadata.modifiedTime = ctx.timestamp;
      metadata.compression = ctx.compression;
      metadata.endianness = ctx.endianness;
      metadata.fileLabel = ctx.conv(header, 109, 64);

      // replace short MR subvariable names with long names
      if (ctx.mrSets) {
        const dictByUpper = new Map<string, SpssVarinfo>();
        for (let i = 0; i < ctx.varIndex; i++) {
          const info = ctx.varinfo[i];
          if (info.name.length) dictByUpper.set(latin1(info.name).toUpperCase(), info);
        }
        for (const mr of ctx.mrSets) {
          for (let j = 0; j < mr.subvariables.length; j++) {
            const info = dictByUpper.get(mr.subvariables[j].toUpperCase());
            if (info) mr.subvariables[j] = latin1(info.longname);
          }
        }
      }
      metadata.multipleResponseSets = ctx.mrSets ?? [];

      if (hstatus(parser.handlers.metadata(metadata, userCtx)) !== HandlerStatus.OK) {
        return ReadStatError.ERROR_USER_ABORT;
      }
    }

    parseVariableDisplayParameterRecord(ctx);
    handleVariables(ctx);
    handleFweight(ctx);

    if (parser.handlers.value) readData(ctx);

    return ReadStatError.OK;
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    if (e instanceof IoReadError) return ReadStatError.ERROR_READ;
    throw e;
  }
}
