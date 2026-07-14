//
// sas/sas7bdat-read.ts — SAS7BDAT reader (port of readstat_sas7bdat_read.c)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import {
  ReadStatType,
  ReadStatMetadata,
  ReadStatCompress,
  ReadStatEndian,
  makeEmptyMetadata,
  HandlerStatus,
  ReadStatSeek,
} from "../types.js";
import { IoContext, ioReadExact, IoReadError } from "../io.js";
import { ReadStatParser } from "../parser.js";
import { Codec, convertString } from "../codec.js";
import { ReadStatValue, makeStringValue, makeDoubleValue } from "../value.js";
import { Variable } from "../variable.js";
import {
  SasHeaderInfo,
  sasReadHeader,
  sasRead2,
  sasRead4,
  sasRead8,
  sasSubheaderRemainder,
  SAS_COLUMN_TYPE_NUM,
  SAS_COLUMN_TYPE_CHR,
  SAS_COMPRESSION_NONE,
  SAS_COMPRESSION_TRUNC,
  SAS_COMPRESSION_ROW,
  SAS_COMPRESSION_SIGNATURE_RDC,
  SAS_PAGE_TYPE_DATA,
  SAS_PAGE_TYPE_MIX,
  SAS_PAGE_TYPE_MASK,
  SAS_PAGE_TYPE_COMP,
  READSTAT_VENDOR_STAT_TRANSFER,
} from "./sas-header.js";
import { sasRleDecompress } from "./sas-rle.js";

const SIG_ROW_SIZE = 0xf7f7f7f7;
const SIG_COLUMN_SIZE = 0xf6f6f6f6;
const SIG_COUNTS = 0xfffffc00;
const SIG_COLUMN_FORMAT = 0xfffffbfe;
const SIG_COLUMN_MASK = 0xfffffff8;
const SIG_COLUMN_ATTRS = 0xfffffffc;
const SIG_COLUMN_TEXT = 0xfffffffd;
const SIG_COLUMN_LIST = 0xfffffffe;
const SIG_COLUMN_NAME = 0xffffffff;

enum SubType {
  DATA,
  ROW_SIZE,
  COLUMN_SIZE,
  COUNTS,
  COLUMN_FORMAT,
  COLUMN_ATTRS,
  COLUMN_TEXT,
  COLUMN_LIST,
  COLUMN_NAME,
  UNKNOWN,
}

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

interface TextRef {
  index: number;
  offset: number;
  length: number;
}

interface ColInfo {
  nameRef: TextRef;
  formatRef: TextRef;
  labelRef: TextRef;
  index: number;
  offset: number;
  width: number;
  type: ReadStatType;
  formatWidth: number;
  formatDigits: number;
}

function makeColInfo(): ColInfo {
  return {
    nameRef: { index: 0, offset: 0, length: 0 },
    formatRef: { index: 0, offset: 0, length: 0 },
    labelRef: { index: 0, offset: 0, length: 0 },
    index: 0, offset: 0, width: 0, type: ReadStatType.DOUBLE, formatWidth: 0, formatDigits: 0,
  };
}

class Ctx {
  io: IoContext;
  parser: ReadStatParser;
  codec: Codec;
  userCtx: unknown;
  hinfo: SasHeaderInfo;
  le: boolean;
  u64: boolean;
  vendor: number;
  srcEncoding: string;

  rowLength = 0;
  pageRowCount = 0;
  parsedRowCount = 0;
  columnCount = 0;
  rowLimit = 0;
  rowOffset = 0;
  didSubmitColumns = false;
  rdcCompression = false;

  headerSize: number;
  pageCount: number;
  pageSize: number;
  pageHeaderSize: number;
  subheaderPointerSize: number;
  subheaderSignatureSize: number;

  textBlobs: Uint8Array[] = [];
  colInfo: ColInfo[] = [];
  colNamesCount = 0;
  colAttrsCount = 0;
  colFormatsCount = 0;
  maxColWidth = 0;
  variables: (Variable | null)[] = [];
  row: Uint8Array = new Uint8Array(0);

  tableName: string;
  fileLabel = "";

  constructor(io: IoContext, parser: ReadStatParser, userCtx: unknown, hinfo: SasHeaderInfo) {
    this.io = io;
    this.parser = parser;
    this.codec = parser.codec;
    this.userCtx = userCtx;
    this.hinfo = hinfo;
    this.le = hinfo.littleEndian;
    this.u64 = hinfo.u64;
    this.vendor = hinfo.vendor;
    this.headerSize = hinfo.headerSize;
    this.pageCount = hinfo.pageCount;
    this.pageSize = hinfo.pageSize;
    this.pageHeaderSize = hinfo.pageHeaderSize;
    this.subheaderPointerSize = hinfo.subheaderPointerSize;
    this.subheaderSignatureSize = hinfo.u64 ? 8 : 4;
    this.srcEncoding = parser.inputEncoding ?? hinfo.encoding;
    this.rowLimit = parser.rowLimit;
    if (parser.rowOffset > 0) this.rowOffset = parser.rowOffset;
    this.tableName = convertString(this.codec, hinfo.tableName, this.srcEncoding, 0, 32);
  }

  conv(b: Uint8Array, off: number, len: number): string {
    return convertString(this.codec, b, this.srcEncoding, off, len);
  }

  readPage(i: number): Uint8Array {
    if (this.io.seek(this.headerSize + i * this.pageSize, ReadStatSeek.SET) === -1) {
      throw new ReadStatException(ReadStatError.ERROR_SEEK);
    }
    return ioReadExact(this.io, this.pageSize);
  }

  reallocColInfo(count: number): void {
    while (this.colInfo.length < count) this.colInfo.push(makeColInfo());
  }
}

function parseTextRef(b: Uint8Array, off: number, ctx: Ctx): TextRef {
  return {
    index: sasRead2(b, off, ctx.le),
    offset: sasRead2(b, off + 2, ctx.le),
    length: sasRead2(b, off + 4, ctx.le),
  };
}

function copyTextRef(ref: TextRef, ctx: Ctx): string {
  if (ref.index >= ctx.textBlobs.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (ref.length === 0) return "";
  const blob = ctx.textBlobs[ref.index];
  if (ref.offset + ref.length > blob.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  return ctx.conv(blob, ref.offset, ref.length);
}

// ---- subheader parsers ----

function parseColumnTextSubheader(sh: Uint8Array, len: number, ctx: Ctx): void {
  const sigLen = ctx.subheaderSignatureSize;
  const remainder = sasRead2(sh, sigLen, ctx.le);
  if (remainder !== sasSubheaderRemainder(len, sigLen)) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.textBlobs.push(sh.slice(sigLen, len));
}

function parseColumnSizeSubheader(sh: Uint8Array, len: number, ctx: Ctx): void {
  if (ctx.columnCount || ctx.didSubmitColumns) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (len < (ctx.u64 ? 16 : 8)) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const colCount = ctx.u64 ? Number(sasRead8(sh, 8, ctx.le)) : sasRead4(sh, 4, ctx.le);
  ctx.columnCount = colCount;
  ctx.reallocColInfo(colCount);
}

function parseRowSizeSubheader(sh: Uint8Array, len: number, ctx: Ctx): void {
  if (len < (ctx.u64 ? 250 : 190)) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  let rowLength: number, totalRowCount: number, pageRowCount: number;
  if (ctx.u64) {
    rowLength = Number(sasRead8(sh, 40, ctx.le));
    totalRowCount = Number(sasRead8(sh, 48, ctx.le));
    pageRowCount = Number(sasRead8(sh, 120, ctx.le));
  } else {
    rowLength = sasRead4(sh, 20, ctx.le);
    totalRowCount = sasRead4(sh, 24, ctx.le);
    pageRowCount = sasRead4(sh, 60, ctx.le);
  }

  const fileLabelRef = parseTextRef(sh, len - 130, ctx);
  if (fileLabelRef.length) ctx.fileLabel = copyTextRef(fileLabelRef, ctx);

  const compressionRef = parseTextRef(sh, len - 118, ctx);
  if (compressionRef.length) {
    const compression = copyTextRef(compressionRef, ctx);
    ctx.rdcCompression = compression.slice(0, 8) === SAS_COMPRESSION_SIGNATURE_RDC;
  }

  ctx.rowLength = rowLength;
  ctx.row = new Uint8Array(rowLength);
  ctx.pageRowCount = pageRowCount;

  let totalAfterSkipping = totalRowCount;
  if (totalRowCount > ctx.rowOffset) totalAfterSkipping -= ctx.rowOffset;
  else {
    totalAfterSkipping = 0;
    ctx.rowOffset = totalRowCount;
  }
  if (ctx.rowLimit === 0 || totalAfterSkipping < ctx.rowLimit) ctx.rowLimit = totalAfterSkipping;
}

function parseColumnNameSubheader(sh: Uint8Array, len: number, ctx: Ctx): void {
  const sigLen = ctx.subheaderSignatureSize;
  const cmax = ctx.u64 ? Math.floor((len - 28) / 8) : Math.floor((len - 20) / 8);
  const remainder = sasRead2(sh, sigLen, ctx.le);
  if (remainder !== sasSubheaderRemainder(len, sigLen)) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.colNamesCount += cmax;
  ctx.reallocColInfo(ctx.colNamesCount);
  let cnp = sigLen + 8;
  for (let i = ctx.colNamesCount - cmax; i < ctx.colNamesCount; i++) {
    ctx.colInfo[i].nameRef = parseTextRef(sh, cnp, ctx);
    cnp += 8;
  }
}

function parseColumnAttributesSubheader(sh: Uint8Array, len: number, ctx: Ctx): void {
  const sigLen = ctx.subheaderSignatureSize;
  const cmax = ctx.u64 ? Math.floor((len - 28) / 16) : Math.floor((len - 20) / 12);
  const remainder = sasRead2(sh, sigLen, ctx.le);
  if (remainder !== sasSubheaderRemainder(len, sigLen)) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.colAttrsCount += cmax;
  ctx.reallocColInfo(ctx.colAttrsCount);
  let cap = sigLen + 8;
  for (let i = ctx.colAttrsCount - cmax; i < ctx.colAttrsCount; i++) {
    const off = ctx.u64 ? 8 : 4;
    ctx.colInfo[i].offset = ctx.u64 ? Number(sasRead8(sh, cap, ctx.le)) : sasRead4(sh, cap, ctx.le);
    ctx.colInfo[i].width = sasRead4(sh, cap + off, ctx.le);
    if (ctx.colInfo[i].width > ctx.maxColWidth) ctx.maxColWidth = ctx.colInfo[i].width;
    const typeByte = sh[cap + off + 6];
    if (typeByte === SAS_COLUMN_TYPE_NUM) ctx.colInfo[i].type = ReadStatType.DOUBLE;
    else if (typeByte === SAS_COLUMN_TYPE_CHR) ctx.colInfo[i].type = ReadStatType.STRING;
    else throw new ReadStatException(ReadStatError.ERROR_PARSE);
    ctx.colInfo[i].index = i;
    cap += off + 8;
  }
}

function parseColumnFormatSubheader(sh: Uint8Array, len: number, ctx: Ctx): void {
  if (len < (ctx.u64 ? 58 : 46)) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.colFormatsCount++;
  ctx.reallocColInfo(ctx.colFormatsCount);
  const ci = ctx.colInfo[ctx.colFormatsCount - 1];
  if (ctx.u64) {
    ci.formatWidth = sasRead2(sh, 24, ctx.le);
    ci.formatDigits = sasRead2(sh, 26, ctx.le);
  } else {
    ci.formatWidth = sasRead2(sh, 12, ctx.le);
    ci.formatDigits = sasRead2(sh, 14, ctx.le);
  }
  ci.formatRef = parseTextRef(sh, ctx.u64 ? 46 : 34, ctx);
  ci.labelRef = parseTextRef(sh, ctx.u64 ? 52 : 40, ctx);
}

function parseSubheaderType32(sig: number): SubType {
  switch (sig >>> 0) {
    case SIG_ROW_SIZE: return SubType.ROW_SIZE;
    case SIG_COLUMN_SIZE: return SubType.COLUMN_SIZE;
    case SIG_COUNTS: return SubType.COUNTS;
    case SIG_COLUMN_FORMAT: return SubType.COLUMN_FORMAT;
    case SIG_COLUMN_ATTRS: return SubType.COLUMN_ATTRS;
    case SIG_COLUMN_TEXT: return SubType.COLUMN_TEXT;
    case SIG_COLUMN_LIST: return SubType.COLUMN_LIST;
    case SIG_COLUMN_NAME: return SubType.COLUMN_NAME;
    default:
      if (((sig >>> 0) & SIG_COLUMN_MASK) >>> 0 === SIG_COLUMN_MASK) return SubType.UNKNOWN;
      return SubType.DATA;
  }
}

function parseSubheaderType(sh: Uint8Array, off: number, ctx: Ctx): SubType {
  if (!ctx.u64) return parseSubheaderType32(sasRead4(sh, off, ctx.le));
  const sig = sasRead8(sh, off, ctx.le);
  if (sig === BigInt(SIG_ROW_SIZE >>> 0) || sig === 0xf7f7f7f7f7f7f7f7n) return SubType.ROW_SIZE;
  if (sig === BigInt(SIG_COLUMN_SIZE >>> 0) || sig === 0xf6f6f6f6f6f6f6f6n) return SubType.COLUMN_SIZE;
  const mask = 0xffffffff00000000n;
  if ((sig & mask) !== mask) return SubType.DATA;
  const lower = Number(sig & 0xffffffffn) >>> 0;
  return parseSubheaderType32(lower);
}

function dispatchSubheader(type: SubType, sh: Uint8Array, len: number, ctx: Ctx): void {
  if (len < 2 + ctx.subheaderSignatureSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  switch (type) {
    case SubType.ROW_SIZE: parseRowSizeSubheader(sh, len, ctx); break;
    case SubType.COLUMN_SIZE: parseColumnSizeSubheader(sh, len, ctx); break;
    case SubType.COUNTS: break;
    case SubType.COLUMN_TEXT: parseColumnTextSubheader(sh, len, ctx); break;
    case SubType.COLUMN_NAME: parseColumnNameSubheader(sh, len, ctx); break;
    case SubType.COLUMN_ATTRS: parseColumnAttributesSubheader(sh, len, ctx); break;
    case SubType.COLUMN_FORMAT: parseColumnFormatSubheader(sh, len, ctx); break;
    case SubType.COLUMN_LIST: break;
    case SubType.UNKNOWN: break;
    default: throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
}

// ---- data values ----

function assignTag(value: ReadStatValue, tag: number): void {
  let t = tag;
  if (t === 0) t = 0x5f; // '_'
  else if (t >= 2 && t < 28) t = 0x41 + (t - 2);
  if (t === 0x5f || (t >= 0x41 && t <= 0x5a)) {
    value.tag = String.fromCharCode(t);
    value.isTaggedMissing = true;
  } else {
    value.tag = "";
    value.isSystemMissing = true;
  }
}

const scratchDv = new DataView(new ArrayBuffer(8));

function handleDataValue(variable: Variable, col: ColInfo, data: Uint8Array, off: number, ctx: Ctx): void {
  let value: ReadStatValue;
  if (col.type === ReadStatType.STRING) {
    value = makeStringValue(ctx.conv(data, off, col.width));
  } else {
    let val = 0n;
    if (ctx.le) {
      for (let k = 0; k < col.width; k++) val = (val << 8n) | BigInt(data[off + col.width - 1 - k]);
    } else {
      for (let k = 0; k < col.width; k++) val = (val << 8n) | BigInt(data[off + k]);
    }
    val = (val << BigInt((8 - col.width) * 8)) & 0xffffffffffffffffn;
    scratchDv.setBigUint64(0, val, true);
    const dval = scratchDv.getFloat64(0, true);
    value = makeDoubleValue(dval);
    if (Number.isNaN(dval)) {
      value.num = NaN;
      value.isSystemMissing = false;
      assignTag(value, ~Number((val >> 40n) & 0xffn) & 0xff);
    } else {
      value.num = dval;
      value.isSystemMissing = false;
    }
  }
  if (hstatus(ctx.parser.handlers.value!(ctx.parsedRowCount, variable, value, ctx.userCtx)) !== HandlerStatus.OK) {
    throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
  }
}

function parseSingleRow(data: Uint8Array, off: number, ctx: Ctx): void {
  if (ctx.parsedRowCount === ctx.rowLimit) return;
  if (ctx.rowOffset) {
    ctx.rowOffset--;
    return;
  }
  if (ctx.parser.handlers.value) {
    for (let j = 0; j < ctx.columnCount; j++) {
      const col = ctx.colInfo[j];
      const variable = ctx.variables[j]!;
      if (variable.skip) continue;
      if (col.offset > ctx.rowLength || col.offset + col.width > ctx.rowLength) {
        throw new ReadStatException(ReadStatError.ERROR_PARSE);
      }
      handleDataValue(variable, col, data, off + col.offset, ctx);
    }
  }
  ctx.parsedRowCount++;
}

function parseRows(data: Uint8Array, dataOff: number, len: number, ctx: Ctx): void {
  let rowOffset = 0;
  for (let i = 0; i < ctx.pageRowCount && ctx.parsedRowCount < ctx.rowLimit; i++) {
    if (rowOffset + ctx.rowLength > len) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
    parseSingleRow(data, dataOff + rowOffset, ctx);
    rowOffset += ctx.rowLength;
  }
}

function parseSubheaderRle(sh: Uint8Array, off: number, len: number, ctx: Ctx): void {
  if (ctx.rowLimit === ctx.parsedRowCount) return;
  const n = sasRleDecompress(ctx.row, ctx.rowLength, sh.subarray(off, off + len));
  if (n !== ctx.rowLength) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
  parseSingleRow(ctx.row, 0, ctx);
}

function parseSubheaderRdc(sh: Uint8Array, off: number, len: number, ctx: Ctx): void {
  const buffer = new Uint8Array(ctx.rowLength);
  let out = 0;
  let ip = off;
  const end = off + len;
  while (ip + 2 <= end) {
    const prefix = (sh[ip] << 8) + sh[ip + 1];
    ip += 2;
    for (let i = 0; i < 16; i++) {
      if ((prefix & (1 << (15 - i))) === 0) {
        if (ip + 1 > end) break;
        if (out + 1 > ctx.rowLength) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
        buffer[out++] = sh[ip++];
        continue;
      }
      if (ip + 2 > end) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      const markerByte = sh[ip++];
      const nextByte = sh[ip++];
      let insertLen = 0;
      let copyLen = 0;
      let insertByte = 0;
      let backOffset = 0;
      if (markerByte <= 0x0f) {
        insertLen = 3 + markerByte;
        insertByte = nextByte;
      } else if (markerByte >> 4 === 1) {
        if (ip + 1 > end) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        insertLen = 19 + (markerByte & 0x0f) + nextByte * 16;
        insertByte = sh[ip++];
      } else if (markerByte >> 4 === 2) {
        if (ip + 1 > end) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        copyLen = 16 + sh[ip++];
        backOffset = 3 + (markerByte & 0x0f) + nextByte * 16;
      } else {
        copyLen = markerByte >> 4;
        backOffset = 3 + (markerByte & 0x0f) + nextByte * 16;
      }
      if (insertLen) {
        if (out + insertLen > ctx.rowLength) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
        buffer.fill(insertByte, out, out + insertLen);
        out += insertLen;
      } else if (copyLen) {
        if (out < backOffset || copyLen > backOffset) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        if (out + copyLen > ctx.rowLength) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
        for (let k = 0; k < copyLen; k++) buffer[out + k] = buffer[out - backOffset + k];
        out += copyLen;
      }
    }
  }
  if (out !== ctx.rowLength) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
  parseSingleRow(buffer, 0, ctx);
}

function parseSubheaderCompressed(sh: Uint8Array, off: number, len: number, ctx: Ctx): void {
  if (ctx.rdcCompression) parseSubheaderRdc(sh, off, len, ctx);
  else parseSubheaderRle(sh, off, len, ctx);
}

// ---- subheader pointers ----

interface ShpInfo {
  offset: number;
  len: number;
  compression: number;
  isCompressedData: number;
}

function parseSubheaderPointer(page: Uint8Array, shp: number, ctx: Ctx): ShpInfo {
  if (ctx.u64) {
    return {
      offset: Number(sasRead8(page, shp, ctx.le)),
      len: Number(sasRead8(page, shp + 8, ctx.le)),
      compression: page[shp + 16],
      isCompressedData: page[shp + 17],
    };
  }
  return {
    offset: sasRead4(page, shp, ctx.le),
    len: sasRead4(page, shp + 4, ctx.le),
    compression: page[shp + 8],
    isCompressedData: page[shp + 9],
  };
}

function validateShp(shp: ShpInfo, pageSize: number, subheaderCount: number, ctx: Ctx): void {
  if (shp.offset > pageSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (shp.len > pageSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (shp.offset + shp.len > pageSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (shp.offset < ctx.pageHeaderSize + subheaderCount * ctx.subheaderPointerSize) {
    throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
  if (shp.compression === SAS_COMPRESSION_NONE) {
    if (shp.len < ctx.subheaderSignatureSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    if (shp.offset + ctx.subheaderSignatureSize > pageSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
}

function parsePagePass1(page: Uint8Array, ctx: Ctx): void {
  const subheaderCount = sasRead2(page, ctx.pageHeaderSize - 4, ctx.le);
  const lshp = ctx.subheaderPointerSize;
  if (ctx.pageHeaderSize + subheaderCount * lshp > ctx.pageSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  let shp = ctx.pageHeaderSize;
  for (let i = 0; i < subheaderCount; i++) {
    const info = parseSubheaderPointer(page, shp, ctx);
    if (info.len > 0 && info.compression !== SAS_COMPRESSION_TRUNC) {
      validateShp(info, ctx.pageSize, subheaderCount, ctx);
      if (info.compression === SAS_COMPRESSION_NONE) {
        const type = parseSubheaderType(page, info.offset, ctx);
        if (type === SubType.COLUMN_TEXT) {
          dispatchSubheader(type, page.subarray(info.offset, info.offset + info.len), info.len, ctx);
        }
      } else if (info.compression === SAS_COMPRESSION_ROW) {
        /* void */
      } else {
        throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_COMPRESSION);
      }
    }
    shp += lshp;
  }
}

function parsePagePass2(page: Uint8Array, ctx: Ctx): void {
  const pageType = sasRead2(page, ctx.pageHeaderSize - 8, ctx.le);
  let dataOff = -1;

  if ((pageType & SAS_PAGE_TYPE_MASK) === SAS_PAGE_TYPE_DATA) {
    ctx.pageRowCount = sasRead2(page, ctx.pageHeaderSize - 6, ctx.le);
    dataOff = ctx.pageHeaderSize;
  } else if (!(pageType & SAS_PAGE_TYPE_COMP)) {
    const subheaderCount = sasRead2(page, ctx.pageHeaderSize - 4, ctx.le);
    const lshp = ctx.subheaderPointerSize;
    if (ctx.pageHeaderSize + subheaderCount * lshp > ctx.pageSize) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    let shp = ctx.pageHeaderSize;
    for (let i = 0; i < subheaderCount; i++) {
      const info = parseSubheaderPointer(page, shp, ctx);
      if (info.len > 0 && info.compression !== SAS_COMPRESSION_TRUNC) {
        validateShp(info, ctx.pageSize, subheaderCount, ctx);
        if (info.compression === SAS_COMPRESSION_NONE) {
          const type = parseSubheaderType(page, info.offset, ctx);
          if (info.isCompressedData && type === SubType.DATA) {
            if (info.len !== ctx.rowLength) throw new ReadStatException(ReadStatError.ERROR_ROW_WIDTH_MISMATCH);
            submitColumnsIfNeeded(ctx, true);
            parseSingleRow(page, info.offset, ctx);
          } else if (type !== SubType.COLUMN_TEXT) {
            dispatchSubheader(type, page.subarray(info.offset, info.offset + info.len), info.len, ctx);
          }
        } else if (info.compression === SAS_COMPRESSION_ROW) {
          submitColumnsIfNeeded(ctx, true);
          parseSubheaderCompressed(page, info.offset, info.len, ctx);
        } else {
          throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_COMPRESSION);
        }
      }
      shp += lshp;
    }
    if ((pageType & SAS_PAGE_TYPE_MASK) === SAS_PAGE_TYPE_MIX) {
      const shpOff = shp;
      if (
        shpOff % 8 === 4 && shpOff + 4 <= ctx.pageSize &&
        (allBytes(page, shpOff, 4, 0x00) || allBytes(page, shpOff, 4, 0x20) || ctx.vendor !== READSTAT_VENDOR_STAT_TRANSFER)
      ) {
        dataOff = shpOff + 4;
      } else {
        dataOff = shpOff;
      }
    }
  }

  if (dataOff >= 0) {
    submitColumnsIfNeeded(ctx, false);
    if (ctx.parser.handlers.value) parseRows(page, dataOff, ctx.pageSize - dataOff, ctx);
  }
}

function allBytes(b: Uint8Array, off: number, n: number, val: number): boolean {
  for (let i = 0; i < n; i++) if (b[off + i] !== val) return false;
  return true;
}

// ---- columns ----

function validateColumn(col: ColInfo): void {
  if (col.type === ReadStatType.DOUBLE && (col.width > 8 || col.width < 3)) {
    throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
  if (col.type === ReadStatType.STRING && col.width > 0x7fff) {
    throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
}

function initVariable(ctx: Ctx, i: number, indexAfterSkipping: number): Variable {
  const col = ctx.colInfo[i];
  const variable = new Variable(col.type, i);
  variable.indexAfterSkipping = indexAfterSkipping;
  variable.storageWidth = col.width;
  validateColumn(col);
  variable.name = copyTextRef(col.nameRef, ctx);
  let format = copyTextRef(col.formatRef, ctx);
  if (col.formatWidth) format += String(col.formatWidth);
  if (format.length && col.formatDigits) format += "." + col.formatDigits;
  variable.format = format;
  variable.label = copyTextRef(col.labelRef, ctx);
  return variable;
}

function submitColumns(ctx: Ctx, compressed: boolean): void {
  if (ctx.parser.handlers.metadata) {
    const metadata: ReadStatMetadata = makeEmptyMetadata();
    metadata.rowCount = ctx.rowLimit;
    metadata.varCount = ctx.columnCount;
    metadata.tableName = ctx.tableName;
    metadata.fileLabel = ctx.fileLabel;
    metadata.fileEncoding = ctx.srcEncoding;
    metadata.creationTime = ctx.hinfo.creationTime;
    metadata.modifiedTime = ctx.hinfo.modificationTime;
    metadata.fileFormatVersion = ctx.hinfo.majorVersion;
    metadata.endianness = ctx.le ? ReadStatEndian.LITTLE : ReadStatEndian.BIG;
    metadata.is64bit = ctx.u64;
    metadata.compression = compressed
      ? ctx.rdcCompression
        ? ReadStatCompress.BINARY
        : ReadStatCompress.ROWS
      : ReadStatCompress.NONE;
    if (hstatus(ctx.parser.handlers.metadata(metadata, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }
  if (ctx.columnCount === 0) return;
  ctx.variables = new Array(ctx.columnCount).fill(null);
  let indexAfterSkipping = 0;
  for (let i = 0; i < ctx.columnCount; i++) {
    const variable = initVariable(ctx, i, indexAfterSkipping);
    ctx.variables[i] = variable;
    if (ctx.parser.handlers.variable) {
      const cb = hstatus(ctx.parser.handlers.variable(i, variable, variable.format || null, ctx.userCtx));
      if (cb === HandlerStatus.ABORT) throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      if (cb === HandlerStatus.SKIP_VARIABLE) variable.skip = 1;
      else indexAfterSkipping++;
    } else {
      indexAfterSkipping++;
    }
  }
}

function submitColumnsIfNeeded(ctx: Ctx, compressed: boolean): void {
  if (!ctx.didSubmitColumns) {
    submitColumns(ctx, compressed);
    ctx.didSubmitColumns = true;
  }
}

function pageType(page: Uint8Array, ctx: Ctx): number {
  return sasRead2(page, ctx.pageHeaderSize - 8, ctx.le);
}

export function parseSas7bdat(parser: ReadStatParser, io: IoContext, userCtx: unknown): ReadStatError {
  try {
    io.seek(0, ReadStatSeek.END);
    io.seek(0, ReadStatSeek.SET);
    const hinfo = sasReadHeader(io, parser.handlers.error ? (m) => parser.handlers.error!(m, userCtx) : undefined);
    const ctx = new Ctx(io, parser, userCtx, hinfo);

    // pass 1: meta pages from the start until a DATA page
    let lastExamined = ctx.pageCount;
    for (let i = 0; i < ctx.pageCount; i++) {
      const page = ctx.readPage(i);
      const pt = pageType(page, ctx);
      if ((pt & SAS_PAGE_TYPE_MASK) === SAS_PAGE_TYPE_DATA) {
        lastExamined = i;
        break;
      }
      if (pt & SAS_PAGE_TYPE_COMP) continue;
      parsePagePass1(page, ctx);
    }

    // pass 1b: AMD pages from the end
    let amdCount = 0;
    for (let i = ctx.pageCount - 1; i > lastExamined; i--) {
      const page = ctx.readPage(i);
      const pt = pageType(page, ctx);
      if ((pt & SAS_PAGE_TYPE_MASK) === SAS_PAGE_TYPE_DATA) {
        if (amdCount > 0) break;
        continue;
      }
      if (pt & SAS_PAGE_TYPE_COMP) continue;
      parsePagePass1(page, ctx);
      amdCount++;
    }

    // pass 2: all pages sequentially
    io.seek(ctx.headerSize, ReadStatSeek.SET);
    for (let i = 0; i < ctx.pageCount; i++) {
      const page = ioReadExact(io, ctx.pageSize);
      parsePagePass2(page, ctx);
      if (ctx.parsedRowCount === ctx.rowLimit) break;
    }

    submitColumnsIfNeeded(ctx, false);

    if (parser.handlers.value && ctx.parsedRowCount !== ctx.rowLimit) {
      return ReadStatError.ERROR_ROW_COUNT_MISMATCH;
    }
    return ReadStatError.OK;
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    if (e instanceof IoReadError) return ReadStatError.ERROR_READ;
    throw e;
  }
}
