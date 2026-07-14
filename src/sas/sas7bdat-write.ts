//
// sas/sas7bdat-write.ts — SAS7BDAT writer (port of readstat_sas7bdat_write.c)
//

import { ReadStatError } from "../errors.js";
import { ReadStatType, ReadStatCompress } from "../types.js";
import { Writer } from "../writer.js";
import { Variable } from "../variable.js";
import {
  SasHeaderInfo,
  sasHeaderInfoInit,
  sasWriteHeader,
  sasBuildHeaderStart,
  sasFillPage,
  sasSubheaderRemainder,
  SAS7BDAT_MAGIC,
  SAS_COLUMN_TYPE_NUM,
  SAS_COLUMN_TYPE_CHR,
  SAS_COMPRESSION_NONE,
  SAS_COMPRESSION_ROW,
  SAS_COMPRESSION_SIGNATURE_RLE,
  SAS_PAGE_TYPE_META,
  SAS_PAGE_TYPE_DATA,
  SAS_DEFAULT_FILE_VERSION,
} from "./sas-header.js";
import { sasValidateVariableName } from "./sas.js";
import { sasRleCompressedLen, sasRleCompress } from "./sas-rle.js";

const SIG_ROW_SIZE = 0xf7f7f7f7;
const SIG_COLUMN_SIZE = 0xf6f6f6f6;
const SIG_COLUMN_FORMAT = 0xfffffbfe;
const SIG_COLUMN_ATTRS = 0xfffffffc;
const SIG_COLUMN_TEXT = 0xfffffffd;
const SIG_COLUMN_LIST = 0xfffffffe;
const SIG_COLUMN_NAME = 0xffffffff;

const utf8 = new TextEncoder();

interface TextRef {
  index: number;
  offset: number;
  length: number;
}

class ColumnText {
  data: Uint8Array;
  capacity: number;
  used = 0;
  index: number;
  constructor(index: number, capacity: number) {
    this.index = index;
    this.capacity = capacity;
    this.data = new Uint8Array(capacity);
  }
}

class ColumnTextArray {
  texts: ColumnText[];
  private blobCapacity: number;
  constructor(blobCapacity: number) {
    this.blobCapacity = blobCapacity;
    this.texts = [new ColumnText(0, blobCapacity)];
  }
  makeRef(str: string): TextRef {
    const bytes = utf8.encode(str);
    const len = bytes.length;
    const padded = Math.floor((len + 3) / 4) * 4;
    let ct = this.texts[this.texts.length - 1];
    if (ct.used + padded > ct.capacity) {
      ct = new ColumnText(this.texts.length, this.blobCapacity);
      this.texts.push(ct);
    }
    const ref: TextRef = { index: ct.index, offset: ct.used + 28, length: len };
    ct.data.set(bytes.subarray(0, Math.min(len, padded)), ct.used);
    ct.used += padded;
    return ref;
  }
}

class Subheader {
  signature: number;
  data: Uint8Array;
  len: number;
  isRowData = false;
  isRowDataCompressed = false;
  constructor(signature: number, len: number) {
    this.signature = signature;
    this.len = len;
    this.data = new Uint8Array(len);
  }
}

function writeTextRef(data: Uint8Array, off: number, ref: TextRef, le = true): void {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  dv.setUint16(off, ref.index, le);
  dv.setUint16(off + 2, ref.offset, le);
  dv.setUint16(off + 4, ref.length, le);
}

function variableWidth(type: ReadStatType, userWidth: number): number {
  return type === ReadStatType.STRING ? userWidth : 8;
}

function rowLength(writer: Writer): number {
  let len = 0;
  for (const v of writer.variables) len += variableWidth(v.type, v.userWidth);
  return len;
}

// ---- subheader builders ----

function colTextSubheaderLength(hinfo: SasHeaderInfo, textUsed: number): number {
  const sigLen = hinfo.u64 ? 8 : 4;
  return sigLen + 28 + textUsed;
}

function buildRowSize(writer: Writer, hinfo: SasHeaderInfo, texts: ColumnTextArray): Subheader {
  const sh = new Subheader(SIG_ROW_SIZE, hinfo.u64 ? 808 : 480);
  const dv = new DataView(sh.data.buffer);
  if (hinfo.u64) {
    dv.setBigInt64(40, BigInt(rowLength(writer)), true);
    dv.setBigInt64(48, BigInt(writer.rowCount), true);
    dv.setBigInt64(72, BigInt(writer.variables.length), true);
    dv.setBigInt64(104, BigInt(hinfo.pageSize), true);
    sh.data.fill(0xff, 128, 144);
  } else {
    dv.setInt32(20, rowLength(writer), true);
    dv.setInt32(24, writer.rowCount, true);
    dv.setInt32(36, writer.variables.length, true);
    dv.setInt32(52, hinfo.pageSize, true);
    sh.data.fill(0xff, 64, 72);
  }
  if (writer.fileLabel) {
    const ref = texts.makeRef(writer.fileLabel);
    writeTextRef(sh.data, sh.len - 130, ref);
  }
  if (writer.compression === ReadStatCompress.ROWS) {
    const ref = texts.makeRef(SAS_COMPRESSION_SIGNATURE_RLE);
    writeTextRef(sh.data, sh.len - 118, ref);
  }
  return sh;
}

function buildColSize(writer: Writer, hinfo: SasHeaderInfo): Subheader {
  const sh = new Subheader(SIG_COLUMN_SIZE, hinfo.u64 ? 24 : 12);
  const dv = new DataView(sh.data.buffer);
  if (hinfo.u64) dv.setBigInt64(8, BigInt(writer.variables.length), true);
  else dv.setInt32(4, writer.variables.length, true);
  return sh;
}

function colNameSubheaderLength(writer: Writer, hinfo: SasHeaderInfo): number {
  return (hinfo.u64 ? 28 : 20) + 8 * writer.variables.length;
}
function colAttrsSubheaderLength(writer: Writer, hinfo: SasHeaderInfo): number {
  return (hinfo.u64 ? 28 : 20) + (hinfo.u64 ? 16 : 12) * writer.variables.length;
}

function buildColName(writer: Writer, hinfo: SasHeaderInfo, texts: ColumnTextArray): Subheader {
  const len = colNameSubheaderLength(writer, hinfo);
  const sigLen = hinfo.u64 ? 8 : 4;
  const sh = new Subheader(SIG_COLUMN_NAME, len);
  new DataView(sh.data.buffer).setUint16(sigLen, sasSubheaderRemainder(len, sigLen), true);
  let p = sigLen + 8;
  for (const v of writer.variables) {
    writeTextRef(sh.data, p, texts.makeRef(v.name));
    p += 8;
  }
  return sh;
}

function buildColAttrs(writer: Writer, hinfo: SasHeaderInfo): Subheader {
  const len = colAttrsSubheaderLength(writer, hinfo);
  const sigLen = hinfo.u64 ? 8 : 4;
  const sh = new Subheader(SIG_COLUMN_ATTRS, len);
  const dv = new DataView(sh.data.buffer);
  dv.setUint16(sigLen, sasSubheaderRemainder(len, sigLen), true);
  let p = sigLen + 8;
  let offset = 0;
  for (const v of writer.variables) {
    const nameLengthFlag = utf8.encode(v.name).length <= 8 ? 4 : 2048;
    let width: number;
    if (hinfo.u64) {
      dv.setBigUint64(p, BigInt(offset), true);
      p += 8;
    } else {
      dv.setUint32(p, offset, true);
      p += 4;
    }
    if (v.type === ReadStatType.STRING) {
      sh.data[p + 6] = SAS_COLUMN_TYPE_CHR;
      width = v.storageWidth;
    } else {
      sh.data[p + 6] = SAS_COLUMN_TYPE_NUM;
      width = 8;
    }
    dv.setUint32(p, width, true);
    dv.setUint16(p + 4, nameLengthFlag, true);
    offset += width;
    p += 8;
  }
  return sh;
}

function buildColFormat(variable: Variable, hinfo: SasHeaderInfo, texts: ColumnTextArray): Subheader {
  const sh = new Subheader(SIG_COLUMN_FORMAT, hinfo.u64 ? 64 : 52);
  const formatOffset = hinfo.u64 ? 46 : 34;
  const labelOffset = hinfo.u64 ? 52 : 40;
  const format = variable.getFormat();
  const label = variable.getLabel();
  if (format) writeTextRef(sh.data, formatOffset, texts.makeRef(format));
  if (label) writeTextRef(sh.data, labelOffset, texts.makeRef(label));
  return sh;
}

function buildColText(hinfo: SasHeaderInfo, ct: ColumnText): Subheader {
  const sigLen = hinfo.u64 ? 8 : 4;
  const len = colTextSubheaderLength(hinfo, ct.used);
  const sh = new Subheader(SIG_COLUMN_TEXT, len);
  new DataView(sh.data.buffer).setUint16(sigLen, sasSubheaderRemainder(len, sigLen), true);
  sh.data.fill(0x20, sigLen + 12, sigLen + 20);
  sh.data.set(ct.data.subarray(0, ct.used), sigLen + 28);
  return sh;
}

// ---- context ----

class SasWriteCtx {
  hinfo: SasHeaderInfo;
  subheaders: Subheader[] = [];
  constructor(hinfo: SasHeaderInfo) {
    this.hinfo = hinfo;
  }
}

function pageIsTooSmall(writer: Writer, hinfo: SasHeaderInfo, rl: number): boolean {
  const pageLen = hinfo.pageSize - hinfo.pageHeaderSize;
  if (writer.compression === ReadStatCompress.NONE && pageLen < rl) return true;
  if (writer.compression === ReadStatCompress.ROWS && pageLen < rl + hinfo.subheaderPointerSize) return true;
  if (pageLen < colNameSubheaderLength(writer, hinfo) + hinfo.subheaderPointerSize) return true;
  if (pageLen < colAttrsSubheaderLength(writer, hinfo) + hinfo.subheaderPointerSize) return true;
  return false;
}

function buildSubheaderArray(writer: Writer, hinfo: SasHeaderInfo): Subheader[] {
  const blobCapacity = hinfo.pageSize - hinfo.pageHeaderSize - hinfo.subheaderPointerSize - colTextSubheaderLength(hinfo, 0);
  const texts = new ColumnTextArray(blobCapacity);

  // build order (matters for text-blob layout): col_name, col_attrs, row_size, col_size, col_format
  const colName = buildColName(writer, hinfo, texts);
  const colAttrs = buildColAttrs(writer, hinfo);
  const rowSize = buildRowSize(writer, hinfo, texts);
  const colSize = buildColSize(writer, hinfo);
  const colFormats = writer.variables.map((v) => buildColFormat(v, hinfo, texts));
  const colTexts = texts.texts.map((ct) => buildColText(hinfo, ct));

  return [rowSize, colSize, ...colTexts, colName, colAttrs, ...colFormats];
}

function subheaderTypeByte(signature: number): number {
  const s = signature >>> 0;
  return s === SIG_COLUMN_TEXT || s === SIG_COLUMN_NAME || s === SIG_COLUMN_ATTRS || s === SIG_COLUMN_LIST ? 1 : 0;
}

function countMetaPages(writer: Writer, ctx: SasWriteCtx): number {
  const hinfo = ctx.hinfo;
  let pages = 1;
  let bytesLeft = hinfo.pageSize - hinfo.pageHeaderSize;
  const shpPtrSize = hinfo.subheaderPointerSize;
  for (let i = ctx.subheaders.length - 1; i >= 0; i--) {
    const sh = ctx.subheaders[i];
    if (sh.len + shpPtrSize > bytesLeft) {
      bytesLeft = hinfo.pageSize - hinfo.pageHeaderSize;
      pages++;
    }
    bytesLeft -= sh.len + shpPtrSize;
  }
  return pages;
}

function rowsPerPage(writer: Writer, hinfo: SasHeaderInfo): number {
  return Math.floor((hinfo.pageSize - hinfo.pageHeaderSize) / rowLength(writer));
}
function countDataPages(writer: Writer, hinfo: SasHeaderInfo): number {
  if (writer.compression === ReadStatCompress.ROWS) return 0;
  const rpp = rowsPerPage(writer, hinfo);
  return Math.floor((writer.rowCount + (rpp - 1)) / rpp);
}

function emitMetaPages(writer: Writer, ctx: SasWriteCtx): ReadStatError {
  const hinfo = ctx.hinfo;
  const pageType = SAS_PAGE_TYPE_META;
  const sarray = ctx.subheaders;
  let shpWritten = 0;
  const shpPtrSize = hinfo.subheaderPointerSize;

  while (sarray.length > shpWritten) {
    const page = new Uint8Array(hinfo.pageSize);
    const pdv = new DataView(page.buffer);
    let shpCount = 0;
    let shpDataOffset = hinfo.pageSize;
    let shpPtrOffset = hinfo.pageHeaderSize;

    pdv.setInt16(hinfo.pageHeaderSize - 8, pageType, true);

    if (sarray[shpWritten].len + shpPtrSize > shpDataOffset - shpPtrOffset) {
      return ReadStatError.ERROR_ROW_IS_TOO_WIDE_FOR_PAGE;
    }

    while (sarray.length > shpWritten && sarray[shpWritten].len + shpPtrSize <= shpDataOffset - shpPtrOffset) {
      const sh = sarray[shpWritten];
      const sig32 = sh.signature >>> 0;
      if (hinfo.u64) {
        pdv.setBigUint64(shpPtrOffset, BigInt(shpDataOffset - sh.len), true);
        pdv.setBigUint64(shpPtrOffset + 8, BigInt(sh.len), true);
        if (sh.isRowData) {
          page[shpPtrOffset + 16] = sh.isRowDataCompressed ? SAS_COMPRESSION_ROW : SAS_COMPRESSION_NONE;
          page[shpPtrOffset + 17] = 1;
        } else {
          page[shpPtrOffset + 17] = subheaderTypeByte(sh.signature);
          if (sig32 >= 0xff000000) {
            new DataView(sh.data.buffer).setBigInt64(0, BigInt(sig32 | 0), true); // sign-extended int32->int64
          } else {
            new DataView(sh.data.buffer).setUint32(0, sig32, true);
          }
        }
      } else {
        pdv.setUint32(shpPtrOffset, shpDataOffset - sh.len, true);
        pdv.setUint32(shpPtrOffset + 4, sh.len, true);
        if (sh.isRowData) {
          page[shpPtrOffset + 8] = sh.isRowDataCompressed ? SAS_COMPRESSION_ROW : SAS_COMPRESSION_NONE;
          page[shpPtrOffset + 9] = 1;
        } else {
          page[shpPtrOffset + 9] = subheaderTypeByte(sh.signature);
          new DataView(sh.data.buffer).setUint32(0, sig32, true);
        }
      }
      shpPtrOffset += shpPtrSize;
      shpDataOffset -= sh.len;
      page.set(sh.data, shpDataOffset);
      shpWritten++;
      shpCount++;
    }

    if (hinfo.u64) {
      pdv.setInt16(34, shpCount, true);
      pdv.setInt16(36, shpCount, true);
    } else {
      pdv.setInt16(18, shpCount, true);
      pdv.setInt16(20, shpCount, true);
    }

    const e = writer.writeBytes(page);
    if (e !== ReadStatError.OK) return e;
  }
  return ReadStatError.OK;
}

function emitHeaderAndMetaPages(writer: Writer, ctx: SasWriteCtx): ReadStatError {
  if (rowLength(writer) === 0) return ReadStatError.ERROR_TOO_FEW_COLUMNS;
  if (writer.compression === ReadStatCompress.NONE && rowsPerPage(writer, ctx.hinfo) === 0) {
    return ReadStatError.ERROR_ROW_IS_TOO_WIDE_FOR_PAGE;
  }
  ctx.hinfo.pageCount = countMetaPages(writer, ctx) + countDataPages(writer, ctx.hinfo);
  const headerStart = sasBuildHeaderStart(SAS7BDAT_MAGIC, ctx.hinfo.u64, 20);
  let e = sasWriteHeader(writer, ctx.hinfo, headerStart);
  if (e !== ReadStatError.OK) return e;
  return emitMetaPages(writer, ctx);
}

// ---- value writers ----

function writeDoubleToRow(writer: Writer, offset: number, value: number): ReadStatError {
  new DataView(writer.row.buffer, writer.row.byteOffset).setFloat64(offset, value, true);
  return ReadStatError.OK;
}
function writeMissingTaggedRaw(writer: Writer, offset: number, tagCode: number): ReadStatError {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, NaN, true);
  buf[5] = ~tagCode & 0xff;
  writer.row.set(buf, offset);
  return ReadStatError.OK;
}
function writeStringToRow(writer: Writer, offset: number, variable: Variable, value: string): ReadStatError {
  const maxLen = variable.storageWidth;
  writer.row.fill(0, offset, offset + maxLen);
  if (value && value.length > 0) {
    const b = utf8.encode(value);
    if (b.length > maxLen) return ReadStatError.ERROR_STRING_VALUE_IS_TOO_LONG;
    writer.row.set(b, offset);
  }
  return ReadStatError.OK;
}

function writeRowUncompressed(writer: Writer, ctx: SasWriteCtx, bytes: Uint8Array): ReadStatError {
  const hinfo = ctx.hinfo;
  const rpp = rowsPerPage(writer, hinfo);
  if (writer.currentRow % rpp === 0) {
    let e = sasFillPage(writer, hinfo);
    if (e !== ReadStatError.OK) return e;
    const pageRowCount = writer.rowCount - writer.currentRow < rpp ? writer.rowCount - writer.currentRow : rpp;
    const header = new Uint8Array(hinfo.pageHeaderSize);
    const hdv = new DataView(header.buffer);
    hdv.setInt16(hinfo.pageHeaderSize - 6, pageRowCount, true);
    hdv.setInt16(hinfo.pageHeaderSize - 8, SAS_PAGE_TYPE_DATA, true);
    e = writer.writeBytes(header);
    if (e !== ReadStatError.OK) return e;
  }
  return writer.writeBytes(bytes);
}

function writeRowCompressed(writer: Writer, ctx: SasWriteCtx, bytes: Uint8Array): ReadStatError {
  const compressedLen = sasRleCompressedLen(bytes);
  let sh: Subheader;
  if (compressedLen < bytes.length) {
    sh = new Subheader(0, compressedLen);
    sh.isRowData = true;
    sh.isRowDataCompressed = true;
    sh.data = sasRleCompress(bytes);
  } else {
    sh = new Subheader(0, bytes.length);
    sh.isRowData = true;
    sh.data = bytes.slice();
  }
  ctx.subheaders.push(sh);
  return ReadStatError.OK;
}

// ---- lifecycle ----

function beginData(writer: Writer): ReadStatError {
  const hinfo = sasHeaderInfoInit(writer, !!writer.is64bit);
  const rl = rowLength(writer);
  while (pageIsTooSmall(writer, hinfo, rl)) hinfo.pageSize <<= 1;
  const ctx = new SasWriteCtx(hinfo);
  ctx.subheaders = buildSubheaderArray(writer, hinfo);
  writer.moduleCtx = ctx;

  if (writer.compression === ReadStatCompress.NONE) {
    return emitHeaderAndMetaPages(writer, ctx);
  }
  return ReadStatError.OK;
}

function endData(writer: Writer): ReadStatError {
  const ctx = writer.moduleCtx as SasWriteCtx;
  if (writer.compression === ReadStatCompress.ROWS) {
    return emitHeaderAndMetaPages(writer, ctx);
  }
  return sasFillPage(writer, ctx.hinfo);
}

function metadataOk(writer: Writer): ReadStatError {
  if (writer.compression !== ReadStatCompress.NONE && writer.compression !== ReadStatCompress.ROWS) {
    return ReadStatError.ERROR_UNSUPPORTED_COMPRESSION;
  }
  return ReadStatError.OK;
}

export function beginWritingSas7bdat(writer: Writer, userCtx: unknown, rowCount: number): ReadStatError {
  if (writer.version === 0) writer.version = SAS_DEFAULT_FILE_VERSION;

  writer.callbacks.metadataOk = metadataOk;
  writer.callbacks.variableWidth = variableWidth;
  writer.callbacks.variableOk = (v) => sasValidateVariableName(v.name);
  writer.callbacks.writeInt8 = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeInt16 = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeInt32 = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeFloat = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeDouble = (w, off, _v, value) => writeDoubleToRow(w, off, value);
  writer.callbacks.writeString = (w, off, v, value) => writeStringToRow(w, off, v, value);
  writer.callbacks.writeMissingString = (w, off, v) => writeStringToRow(w, off, v, "");
  writer.callbacks.writeMissingNumber = (w, off) => writeMissingTaggedRaw(w, off, 0x2e);
  writer.callbacks.writeMissingTagged = (w, off, _v, tag) => {
    const t = tag.charCodeAt(0);
    if (t === 0x5f || (t >= 0x41 && t <= 0x5a)) return writeMissingTaggedRaw(w, off, t);
    return ReadStatError.ERROR_TAGGED_VALUE_IS_OUT_OF_RANGE;
  };
  writer.callbacks.beginData = beginData;
  writer.callbacks.endData = endData;
  writer.callbacks.writeRow = (w, row, len) => {
    const ctx = w.moduleCtx as SasWriteCtx;
    if (w.compression === ReadStatCompress.NONE) return writeRowUncompressed(w, ctx, row.subarray(0, len));
    if (w.compression === ReadStatCompress.ROWS) return writeRowCompressed(w, ctx, row.subarray(0, len));
    return ReadStatError.OK;
  };

  return writer.beginWritingFile(userCtx, rowCount);
}
