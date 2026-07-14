//
// sas/sas7bcat.ts — SAS catalog (.sas7bcat) value-label reader + writer
// (port of readstat_sas7bcat_read.c / readstat_sas7bcat_write.c)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import {
  ReadStatType,
  ReadStatMetadata,
  ReadStatEndian,
  makeEmptyMetadata,
  HandlerStatus,
  ReadStatSeek,
} from "../types.js";
import { IoContext, ioReadExact, IoReadError } from "../io.js";
import { ReadStatParser } from "../parser.js";
import { Writer } from "../writer.js";
import { LabelSet } from "../labelset.js";
import { Codec, convertString } from "../codec.js";
import { ReadStatValue, makeStringValue, makeDoubleValue } from "../value.js";
import {
  sasReadHeader,
  sasHeaderInfoInit,
  sasWriteHeader,
  sasBuildHeaderStart,
  SAS7BCAT_MAGIC,
  SAS_DEFAULT_FILE_VERSION,
} from "./sas-header.js";

const SAS_CATALOG_FIRST_INDEX_PAGE = 1;
const SAS_CATALOG_USELESS_PAGES = 3;

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

function u16(b: Uint8Array, off: number, le: boolean): number {
  return new DataView(b.buffer, b.byteOffset + off, 2).getUint16(0, le);
}
function u32(b: Uint8Array, off: number, le: boolean): number {
  return new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0, le);
}
function u64be(b: Uint8Array, off: number): bigint {
  return new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, false);
}

const scratch = new DataView(new ArrayBuffer(8));

// ---- reader ----

interface BcatCtx {
  io: IoContext;
  parser: ReadStatParser;
  codec: Codec;
  userCtx: unknown;
  u64: boolean;
  pad1: number;
  le: boolean;
  srcEncoding: string;
  headerSize: number;
  pageCount: number;
  pageSize: number;
  xlsrSize: number;
  xlsrOffset: number;
  xlsrOOffset: number;
  blockPointers: bigint[];
}

function conv(ctx: BcatCtx, b: Uint8Array, off: number, len: number): string {
  return convertString(ctx.codec, b, ctx.srcEncoding, off, len);
}

function assignTag(value: ReadStatValue, tag: number): void {
  let t = tag & 0xff;
  if (t === 0) t = 0x5f;
  else if (t >= 2 && t < 28) t = 0x41 + (t - 2);
  if (t === 0x5f || (t >= 0x41 && t <= 0x5a)) {
    value.tag = String.fromCharCode(t);
    value.isTaggedMissing = true;
  } else {
    value.tag = "";
    value.isSystemMissing = true;
  }
}

function parseValueLabels(data: Uint8Array, valueStart: number, valueLabelsLen: number, labelCountUsed: number, labelCountCapacity: number, name: string, ctx: BcatCtx): void {
  const isString = name[0] === "$";
  const valueOffset = new Array<number>(labelCountUsed).fill(0);

  // pass 1: label offsets
  let lbp1 = valueStart;
  for (let i = 0; i < labelCountCapacity; i++) {
    if (lbp1 + 4 - valueStart > valueLabelsLen) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    if (i < labelCountUsed) {
      if (lbp1 + 10 + ctx.pad1 + 4 - valueStart > valueLabelsLen) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      const labelPos = u32(data, lbp1 + 10 + ctx.pad1, ctx.le);
      if (labelPos >= labelCountUsed) throw new ReadStatException(ReadStatError.ERROR_PARSE);
      valueOffset[labelPos] = lbp1 - valueStart;
    }
    lbp1 += 6 + u16(data, lbp1 + 2, ctx.le);
  }

  // pass 2: value/label pairs
  let lbp2 = lbp1;
  for (let i = 0; i < labelCountUsed && i < labelCountCapacity; i++) {
    lbp1 = valueStart + valueOffset[i];
    if (lbp1 + 30 - valueStart > valueLabelsLen || lbp2 + 10 - valueStart > valueLabelsLen) {
      throw new ReadStatException(ReadStatError.ERROR_PARSE);
    }
    let value: ReadStatValue;
    if (isString) {
      const valueEntryLen = 6 + u16(data, lbp1 + 2, ctx.le);
      value = makeStringValue(conv(ctx, data, lbp1 + valueEntryLen - 16, 16));
    } else {
      const val = u64be(data, lbp1 + 22);
      value = makeDoubleValue(NaN);
      if ((val | 0xff0000000000n) === 0xffffffffffffn) {
        assignTag(value, Number(val >> 40n));
      } else {
        scratch.setBigUint64(0, val, true);
        let dval = scratch.getFloat64(0, true);
        if (dval > 0) {
          const v2 = ~val & 0xffffffffffffffffn;
          scratch.setBigUint64(0, v2, true);
          dval = scratch.getFloat64(0, true);
        } else {
          dval *= -1;
        }
        value.num = dval;
        value.isSystemMissing = false;
      }
    }
    let labelLen = u16(data, lbp2 + 8, ctx.le);
    if (lbp2 + 10 > valueStart + valueLabelsLen) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    if (labelLen > valueStart + valueLabelsLen - (lbp2 + 10)) labelLen = valueStart + valueLabelsLen - (lbp2 + 10);
    if (ctx.parser.handlers.valueLabel) {
      const label = conv(ctx, data, lbp2 + 10, labelLen);
      if (hstatus(ctx.parser.handlers.valueLabel(name, value, label, ctx.userCtx)) !== HandlerStatus.OK) {
        throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      }
    }
    lbp2 += 8 + 2 + labelLen + 1;
  }
}

function parseBlock(data: Uint8Array, dataSize: number, ctx: BcatCtx): void {
  let payloadOffset = 106;
  if (dataSize < payloadOffset) return;
  const flags = u16(data, 2, ctx.le);
  let pad = flags & 0x08 ? 4 : 0;
  let labelCountCapacity: number, labelCountUsed: number;
  if (ctx.u64) {
    labelCountCapacity = Number(new DataView(data.buffer, data.byteOffset + 42 + pad, 8).getBigUint64(0, ctx.le));
    labelCountUsed = Number(new DataView(data.buffer, data.byteOffset + 50 + pad, 8).getBigUint64(0, ctx.le));
    payloadOffset += 32;
  } else {
    labelCountCapacity = u32(data, 38 + pad, ctx.le);
    labelCountUsed = u32(data, 42 + pad, ctx.le);
  }
  let name = conv(ctx, data, 8, 8);
  if (pad) pad += 16;
  const hasLongName = (flags & 0x80 && !ctx.u64) || (flags & 0x20 && ctx.u64);
  if (hasLongName) {
    if (dataSize < payloadOffset + pad + 32) return;
    name = conv(ctx, data, payloadOffset + pad, 32);
    pad += 32;
  }
  if (dataSize < payloadOffset + pad) return;
  if (labelCountUsed === 0) return;
  parseValueLabels(data, payloadOffset + pad, dataSize - payloadOffset - pad, labelCountUsed, labelCountCapacity, name, ctx);
}

function augmentIndex(page: Uint8Array, indexOff: number, len: number, ctx: BcatCtx): void {
  let xlsr = indexOff;
  const end = indexOff + len;
  const latin = (off: number, n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(page[off + i]);
    return s;
  };
  while (xlsr + ctx.xlsrSize <= end) {
    if (latin(xlsr, 4) !== "XLSR") xlsr += 8;
    if (latin(xlsr, 4) !== "XLSR") break;
    if (page[xlsr + ctx.xlsrOOffset] === 0x4f /* 'O' */) {
      let pageNo: number, pos: number;
      if (ctx.u64) {
        pageNo = u32(page, xlsr + 8, ctx.le);
        pos = u16(page, xlsr + 16, ctx.le);
      } else {
        pageNo = u32(page, xlsr + 4, ctx.le);
        pos = u16(page, xlsr + 8, ctx.le);
      }
      ctx.blockPointers.push((BigInt(pageNo) << 32n) + BigInt(pos));
    }
    xlsr += ctx.xlsrSize;
  }
}

function blockSize(startPage: number, startPagePos: number, ctx: BcatCtx): number {
  let nextPage = startPage;
  let nextPagePos = startPagePos;
  let linkCount = 0;
  let bufferLen = 0;
  const headerLen = ctx.u64 ? 32 : 16;
  while (nextPage > 0 && nextPagePos > 0 && nextPage <= ctx.pageCount && linkCount++ < ctx.pageCount) {
    if (ctx.io.seek(ctx.headerSize + (nextPage - 1) * ctx.pageSize + nextPagePos, ReadStatSeek.SET) === -1) {
      throw new ReadStatException(ReadStatError.ERROR_SEEK);
    }
    const link = ioReadExact(ctx.io, headerLen);
    let chainLinkLen: number;
    if (ctx.u64) {
      nextPage = u32(link, 0, ctx.le);
      nextPagePos = u16(link, 8, ctx.le);
      chainLinkLen = u16(link, 10, ctx.le);
    } else {
      nextPage = u32(link, 0, ctx.le);
      nextPagePos = u16(link, 4, ctx.le);
      chainLinkLen = u16(link, 6, ctx.le);
    }
    bufferLen += chainLinkLen;
  }
  return bufferLen;
}

function readBlock(bufferLen: number, startPage: number, startPagePos: number, ctx: BcatCtx): Uint8Array {
  const buffer = new Uint8Array(bufferLen);
  let nextPage = startPage;
  let nextPagePos = startPagePos;
  let linkCount = 0;
  let bufferOffset = 0;
  const headerLen = ctx.u64 ? 32 : 16;
  while (nextPage > 0 && nextPagePos > 0 && nextPage <= ctx.pageCount && linkCount++ < ctx.pageCount) {
    if (ctx.io.seek(ctx.headerSize + (nextPage - 1) * ctx.pageSize + nextPagePos, ReadStatSeek.SET) === -1) {
      throw new ReadStatException(ReadStatError.ERROR_SEEK);
    }
    const link = ioReadExact(ctx.io, headerLen);
    let chainLinkLen: number;
    if (ctx.u64) {
      nextPage = u32(link, 0, ctx.le);
      nextPagePos = u16(link, 8, ctx.le);
      chainLinkLen = u16(link, 10, ctx.le);
    } else {
      nextPage = u32(link, 0, ctx.le);
      nextPagePos = u16(link, 4, ctx.le);
      chainLinkLen = u16(link, 6, ctx.le);
    }
    if (bufferOffset + chainLinkLen > bufferLen) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const chunk = ioReadExact(ctx.io, chainLinkLen);
    buffer.set(chunk, bufferOffset);
    bufferOffset += chainLinkLen;
  }
  return buffer;
}

export function parseSas7bcat(parser: ReadStatParser, io: IoContext, userCtx: unknown): ReadStatError {
  try {
    io.seek(0, ReadStatSeek.END);
    io.seek(0, ReadStatSeek.SET);
    const hinfo = sasReadHeader(io, parser.handlers.error ? (m) => parser.handlers.error!(m, userCtx) : undefined);
    const ctx: BcatCtx = {
      io, parser, codec: parser.codec, userCtx,
      u64: hinfo.u64, pad1: hinfo.pad1, le: hinfo.littleEndian,
      srcEncoding: parser.inputEncoding ?? hinfo.encoding,
      headerSize: hinfo.headerSize, pageCount: hinfo.pageCount, pageSize: hinfo.pageSize,
      xlsrSize: 212 + hinfo.pad1, xlsrOffset: 856 + 2 * hinfo.pad1, xlsrOOffset: 50 + hinfo.pad1,
      blockPointers: [],
    };
    if (ctx.u64) {
      ctx.xlsrOffset += 144;
      ctx.xlsrSize += 72;
      ctx.xlsrOOffset += 24;
    }

    if (parser.handlers.metadata) {
      const metadata: ReadStatMetadata = makeEmptyMetadata();
      metadata.fileEncoding = ctx.srcEncoding;
      metadata.creationTime = hinfo.creationTime;
      metadata.modifiedTime = hinfo.modificationTime;
      metadata.fileFormatVersion = hinfo.majorVersion;
      metadata.endianness = ctx.le ? ReadStatEndian.LITTLE : ReadStatEndian.BIG;
      metadata.is64bit = ctx.u64;
      metadata.tableName = convertString(ctx.codec, hinfo.tableName, ctx.srcEncoding, 0, 32);
      if (hstatus(parser.handlers.metadata(metadata, userCtx)) !== HandlerStatus.OK) {
        return ReadStatError.ERROR_USER_ABORT;
      }
    }

    // first index page
    io.seek(ctx.headerSize + SAS_CATALOG_FIRST_INDEX_PAGE * ctx.pageSize, ReadStatSeek.SET);
    let page = ioReadExact(io, ctx.pageSize);
    augmentIndex(page, ctx.xlsrOffset, ctx.pageSize - ctx.xlsrOffset, ctx);

    // pass 1: further XLSR pages
    for (let i = SAS_CATALOG_USELESS_PAGES; i < ctx.pageCount; i++) {
      io.seek(ctx.headerSize + i * ctx.pageSize, ReadStatSeek.SET);
      page = ioReadExact(io, ctx.pageSize);
      let hdr = "";
      for (let k = 0; k < 4; k++) hdr += String.fromCharCode(page[16 + k]);
      if (hdr === "XLSR") augmentIndex(page, 16, ctx.pageSize - 16, ctx);
    }

    ctx.blockPointers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    ctx.blockPointers = ctx.blockPointers.filter((v, idx) => idx === 0 || v !== ctx.blockPointers[idx - 1]);

    // pass 2: read blocks
    for (const bp of ctx.blockPointers) {
      const startPage = Number(bp >> 32n);
      const startPagePos = Number(bp & 0xffffn);
      const len = blockSize(startPage, startPagePos, ctx);
      if (len === 0) continue;
      const buffer = readBlock(len, startPage, startPagePos, ctx);
      parseBlock(buffer, len, ctx);
    }

    return ReadStatError.OK;
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    if (e instanceof IoReadError) return ReadStatError.ERROR_READ;
    throw e;
  }
}

// ---- writer ----

const utf8 = new TextEncoder();

function blockForLabelSet(ls: LabelSet): Uint8Array {
  const nameBytes = utf8.encode(ls.name);
  let nameLen = nameBytes.length;
  let len = 106;
  const longName = nameLen > 8;
  if (longName) {
    len += 32;
    if (nameLen > 32) nameLen = 32;
  }
  const labelByteList = ls.valueLabels.map((vl) => utf8.encode(vl.label));
  for (const lb of labelByteList) len += 30 + 8 + 2 + lb.length + 1;

  const block = new Uint8Array(len);
  const dv = new DataView(block.buffer);
  const count = ls.valueLabels.length;
  dv.setInt32(38, count, true);
  dv.setInt32(42, count, true);

  let begin = 106;
  if (longName) {
    dv.setInt16(2, 0x80, true);
    block.set(nameBytes.subarray(0, 8), 8);
    block.fill(0x20, 106, 138);
    block.set(nameBytes.subarray(0, nameLen), 106);
    begin += 32;
  } else {
    block.fill(0x20, 8, 16);
    block.set(nameBytes.subarray(0, nameLen), 8);
  }

  let lbp1 = begin;
  let lbp2 = begin + count * 30;
  for (let j = 0; j < count; j++) {
    const vl = ls.valueLabels[j];
    const lb = labelByteList[j];
    dv.setInt16(lbp1 + 2, 24, true); // value_entry_len
    dv.setInt32(lbp1 + 10, j, true); // index
    if (ls.type === ReadStatType.STRING) {
      const key = utf8.encode(vl.stringKey ?? "");
      block.fill(0x20, lbp1 + 14, lbp1 + 30);
      block.set(key.subarray(0, Math.min(16, key.length)), lbp1 + 14);
    } else {
      const buf = new Uint8Array(8);
      const bdv = new DataView(buf.buffer);
      const value = vl.doubleKey;
      if (value >= 0) {
        bdv.setFloat64(0, -value, false); // BE of -value
      } else {
        bdv.setFloat64(0, value, false); // BE of value
        for (let k = 0; k < 8; k++) buf[k] = ~buf[k] & 0xff;
      }
      block.set(buf, lbp1 + 22);
    }
    dv.setInt16(lbp2 + 8, lb.length, true);
    block.set(lb, lbp2 + 10);
    lbp1 += 30;
    lbp2 += 8 + 2 + lb.length + 1;
  }
  return block;
}

function bcatBeginData(writer: Writer): ReadStatError {
  const hinfo = sasHeaderInfoInit(writer, false);
  const blocks = writer.labelSets.map((ls) => blockForLabelSet(ls));
  hinfo.pageCount = 4;

  const headerStart = sasBuildHeaderStart(SAS7BCAT_MAGIC, false, 20);
  // file_info = "CATALOG " (offset 156)
  headerStart.set(utf8.encode("CATALOG "), 156);
  let e = sasWriteHeader(writer, hinfo, headerStart);
  if (e !== ReadStatError.OK) return e;

  // page 0
  if ((e = writer.writeZeros(hinfo.pageSize)) !== ReadStatError.OK) return e;

  // page 1: XLSR index
  const page1 = new Uint8Array(hinfo.pageSize);
  const p1dv = new DataView(page1.buffer);
  let xlsr = 856;
  let blockOff = 16;
  for (const block of blocks) {
    if (xlsr + 212 > hinfo.pageSize) break;
    page1.set(utf8.encode("XLSR"), xlsr);
    p1dv.setInt32(xlsr + 4, 4, true); // block_idx
    p1dv.setInt16(xlsr + 8, blockOff, true);
    page1[xlsr + 50] = 0x4f; // 'O'
    // advance past this block's 16-byte chain-link header + its data, matching
    // the page-3 layout (upstream C omits the header size, mis-locating blocks
    // after the first when a catalog has multiple label sets)
    blockOff += 16 + block.length;
    xlsr += 212;
  }
  if ((e = writer.writeBytes(page1)) !== ReadStatError.OK) return e;

  // page 2
  if ((e = writer.writeZeros(hinfo.pageSize)) !== ReadStatError.OK) return e;

  // page 3: blocks
  const page3 = new Uint8Array(hinfo.pageSize);
  const p3dv = new DataView(page3.buffer);
  blockOff = 16;
  for (const block of blocks) {
    if (blockOff + 16 + block.length > hinfo.pageSize) break;
    p3dv.setInt32(blockOff, 0, true); // next_page
    p3dv.setInt16(blockOff + 4, 0, true); // next_off
    p3dv.setInt16(blockOff + 6, block.length, true); // block_len
    blockOff += 16;
    page3.set(block, blockOff);
    blockOff += block.length;
  }
  if ((e = writer.writeBytes(page3)) !== ReadStatError.OK) return e;

  return ReadStatError.OK;
}

export function beginWritingSas7bcat(writer: Writer, userCtx: unknown): ReadStatError {
  if (writer.version === 0) writer.version = SAS_DEFAULT_FILE_VERSION;
  writer.callbacks.beginData = bcatBeginData;
  return writer.beginWritingFile(userCtx, 0);
}
