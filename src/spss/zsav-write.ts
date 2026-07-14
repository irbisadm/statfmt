//
// spss/zsav-write.ts — ZSAV (zlib-compressed SAV) writer
// (port of readstat_zsav_write.c + readstat_zsav_compress.c)
//

import { deflateSync } from "node:zlib";
import { Writer } from "../writer.js";
import { ReadStatError } from "../errors.js";
import { BinaryWriter } from "../binary.js";
import { savCompressRow } from "./sav-compress.js";

const UNCOMPRESSED_BLOCK_SIZE = 0x3ff000;

export class ZsavCtx {
  buffer: Uint8Array; // scratch for the row-level (bytecode) compression
  private chunks: Uint8Array[] = [];
  private totalLen = 0;
  zheaderOfs: number;
  uncompressedBlockSize = UNCOMPRESSED_BLOCK_SIZE;

  constructor(maxRowLen: number, offset: number) {
    this.buffer = new Uint8Array(maxRowLen);
    this.zheaderOfs = offset;
  }

  append(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice());
    this.totalLen += bytes.length;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.totalLen);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

export function zsavWriteCompressedRow(writer: Writer, row: Uint8Array): ReadStatError {
  const zctx = writer.moduleCtx as ZsavCtx;
  const rowLen = savCompressRow(zctx.buffer, row, writer);
  zctx.append(zctx.buffer.subarray(0, rowLen));
  return ReadStatError.OK;
}

interface ZBlock {
  uncompressedSize: number;
  compressed: Uint8Array;
}

export function zsavEndData(writer: Writer): ReadStatError {
  const zctx = writer.moduleCtx as ZsavCtx;
  const data = zctx.concat();

  // Split the row-compressed stream into fixed-size blocks and zlib-deflate each.
  const blocks: ZBlock[] = [];
  for (let off = 0; off < data.length; off += zctx.uncompressedBlockSize) {
    const chunk = data.subarray(off, Math.min(off + zctx.uncompressedBlockSize, data.length));
    const compressed = new Uint8Array(deflateSync(chunk));
    blocks.push({ uncompressedSize: chunk.length, compressed });
  }

  const nBlocks = blocks.length;
  let totalCompressed = 0;
  for (const b of blocks) totalCompressed += b.compressed.length;

  const zheaderOfs = zctx.zheaderOfs;
  const ztrailerOfs = zheaderOfs + 24 + totalCompressed;
  const ztrailerLen = 24 + nBlocks * 24;

  // header
  const header = new BinaryWriter(true, 24);
  header.u64(BigInt(zheaderOfs)).u64(BigInt(ztrailerOfs)).u64(BigInt(ztrailerLen));
  let retval = writer.writeBytes(header.finish());
  if (retval !== ReadStatError.OK) return retval;

  // blocks
  for (const b of blocks) {
    retval = writer.writeBytes(b.compressed);
    if (retval !== ReadStatError.OK) return retval;
  }

  // trailer
  const trailer = new BinaryWriter(true, 24 + nBlocks * 24);
  trailer.i64(-100n).i64(0n).i32(zctx.uncompressedBlockSize).i32(nBlocks);
  let uncompressedOfs = zheaderOfs;
  let compressedOfs = zheaderOfs + 24;
  for (const b of blocks) {
    trailer.i64(BigInt(uncompressedOfs));
    trailer.i64(BigInt(compressedOfs));
    trailer.i32(b.uncompressedSize);
    trailer.i32(b.compressed.length);
    uncompressedOfs += b.uncompressedSize;
    compressedOfs += b.compressed.length;
  }
  return writer.writeBytes(trailer.finish());
}
