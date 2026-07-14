//
// sas/sas-rle.ts — SAS7BDAT row RLE compression (port of readstat_sas_rle.c)
//

const CMD_COPY64 = 0;
const CMD_COPY64_PLUS_4096 = 1;
const CMD_COPY96 = 2;
const CMD_INSERT_BYTE18 = 4;
const CMD_INSERT_AT17 = 5;
const CMD_INSERT_BLANK17 = 6;
const CMD_INSERT_ZERO17 = 7;
const CMD_COPY1 = 8;
const CMD_COPY17 = 9;
const CMD_COPY33 = 10;
const CMD_COPY49 = 11;
const CMD_INSERT_BYTE3 = 12;
const CMD_INSERT_AT2 = 13;
const CMD_INSERT_BLANK2 = 14;
const CMD_INSERT_ZERO2 = 15;

const MAX_INSERT_RUN = 4112;
const MAX_COPY_RUN = 4159;

const commandLengths = new Array(16).fill(0);
commandLengths[CMD_COPY64] = 1;
commandLengths[CMD_COPY64_PLUS_4096] = 1;
commandLengths[CMD_INSERT_BYTE18] = 2;
commandLengths[CMD_INSERT_AT17] = 1;
commandLengths[CMD_INSERT_BLANK17] = 1;
commandLengths[CMD_INSERT_ZERO17] = 1;
commandLengths[CMD_INSERT_BYTE3] = 1;

/** Decompress SAS RLE data into a buffer of known length. Returns bytes written, or -1. */
export function sasRleDecompress(output: Uint8Array | null, outputLen: number, input: Uint8Array): number {
  let ip = 0;
  let written = 0;
  const inLen = input.length;
  while (ip < inLen) {
    const control = input[ip++];
    const command = (control & 0xf0) >> 4;
    const length = control & 0x0f;
    let copyLen = 0;
    let insertLen = 0;
    let insertByte = 0;
    if (ip + commandLengths[command] > inLen) return -1;
    switch (command) {
      case CMD_COPY64:
        copyLen = input[ip++] + 64 + length * 256;
        break;
      case CMD_COPY64_PLUS_4096:
        copyLen = input[ip++] + 64 + length * 256 + 4096;
        break;
      case CMD_COPY96:
        copyLen = length + 96;
        break;
      case CMD_INSERT_BYTE18:
        insertLen = input[ip++] + 18 + length * 256;
        insertByte = input[ip++];
        break;
      case CMD_INSERT_AT17:
        insertLen = input[ip++] + 17 + length * 256;
        insertByte = 0x40;
        break;
      case CMD_INSERT_BLANK17:
        insertLen = input[ip++] + 17 + length * 256;
        insertByte = 0x20;
        break;
      case CMD_INSERT_ZERO17:
        insertLen = input[ip++] + 17 + length * 256;
        insertByte = 0x00;
        break;
      case CMD_COPY1:
        copyLen = length + 1;
        break;
      case CMD_COPY17:
        copyLen = length + 17;
        break;
      case CMD_COPY33:
        copyLen = length + 33;
        break;
      case CMD_COPY49:
        copyLen = length + 49;
        break;
      case CMD_INSERT_BYTE3:
        insertByte = input[ip++];
        insertLen = length + 3;
        break;
      case CMD_INSERT_AT2:
        insertByte = 0x40;
        insertLen = length + 2;
        break;
      case CMD_INSERT_BLANK2:
        insertByte = 0x20;
        insertLen = length + 2;
        break;
      case CMD_INSERT_ZERO2:
        insertByte = 0x00;
        insertLen = length + 2;
        break;
      default:
        break;
    }
    if (copyLen) {
      if (written + copyLen > outputLen) return -1;
      if (ip + copyLen > inLen) return -1;
      if (output) output.set(input.subarray(ip, ip + copyLen), written);
      ip += copyLen;
      written += copyLen;
    }
    if (insertLen) {
      if (written + insertLen > outputLen) return -1;
      if (output) output.fill(insertByte, written, written + insertLen);
      written += insertLen;
    }
  }
  return written;
}

// ---- compression ----

function isSpecialByte(b: number): boolean {
  return b === 0x40 || b === 0x20 || b === 0x00;
}
function measureCopyRun(copyRun: number): number {
  let len = 0;
  while (copyRun >= MAX_COPY_RUN) {
    len += 2 + MAX_COPY_RUN;
    copyRun -= MAX_COPY_RUN;
  }
  return len + (copyRun > 64 ? 1 : 0) + (copyRun > 0 ? 1 : 0) + copyRun;
}
function measureInsertRun(lastByte: number, insertRun: number): number {
  if (isSpecialByte(lastByte)) return insertRun > 17 ? 2 : 1;
  return insertRun > 18 ? 3 : 2;
}
function isInsertRun(lastByte: number, insertRun: number): boolean {
  if (isSpecialByte(lastByte)) return insertRun > 1;
  return insertRun > 2;
}

function copyRunEmit(out: Uint8Array | null, offset: number, input: Uint8Array, copyStart: number, copyRun: number): number {
  if (out === null) return measureCopyRun(copyRun);
  let o = offset;
  let cs = copyStart;
  while (copyRun >= MAX_COPY_RUN) {
    out[o++] = (CMD_COPY64 << 4) + 0x0f;
    out[o++] = 0xff;
    out.set(input.subarray(cs, cs + MAX_COPY_RUN), o);
    o += MAX_COPY_RUN;
    cs += MAX_COPY_RUN;
    copyRun -= MAX_COPY_RUN;
  }
  if (copyRun > 64) {
    const length = Math.floor((copyRun - 64) / 256);
    const rem = (copyRun - 64) % 256;
    out[o++] = (CMD_COPY64 << 4) + (length & 0x0f);
    out[o++] = rem;
  } else if (copyRun >= 49) {
    out[o++] = (CMD_COPY49 << 4) + (copyRun - 49);
  } else if (copyRun >= 33) {
    out[o++] = (CMD_COPY33 << 4) + (copyRun - 33);
  } else if (copyRun >= 17) {
    out[o++] = (CMD_COPY17 << 4) + (copyRun - 17);
  } else if (copyRun >= 1) {
    out[o++] = (CMD_COPY1 << 4) + (copyRun - 1);
  }
  out.set(input.subarray(cs, cs + copyRun), o);
  o += copyRun;
  return o - offset;
}

function insertRunEmit(out: Uint8Array | null, offset: number, lastByte: number, insertRun: number): number {
  if (out === null) return measureInsertRun(lastByte, insertRun);
  let o = offset;
  if (isSpecialByte(lastByte)) {
    if (insertRun > 17) {
      const length = Math.floor((insertRun - 17) / 256);
      const rem = (insertRun - 17) % 256;
      if (lastByte === 0x40) out[o++] = (CMD_INSERT_AT17 << 4) + (length & 0x0f);
      else if (lastByte === 0x20) out[o++] = (CMD_INSERT_BLANK17 << 4) + (length & 0x0f);
      else out[o++] = (CMD_INSERT_ZERO17 << 4) + (length & 0x0f);
      out[o++] = rem;
    } else if (insertRun >= 2) {
      if (lastByte === 0x40) out[o++] = (CMD_INSERT_AT2 << 4) + (insertRun - 2);
      else if (lastByte === 0x20) out[o++] = (CMD_INSERT_BLANK2 << 4) + (insertRun - 2);
      else out[o++] = (CMD_INSERT_ZERO2 << 4) + (insertRun - 2);
    }
  } else if (insertRun > 18) {
    const length = Math.floor((insertRun - 18) / 256);
    const rem = (insertRun - 18) % 256;
    out[o++] = (CMD_INSERT_BYTE18 << 4) + (length & 0x0f);
    out[o++] = rem;
    out[o++] = lastByte;
  } else if (insertRun >= 3) {
    out[o++] = (CMD_INSERT_BYTE3 << 4) + (insertRun - 3);
    out[o++] = lastByte;
  }
  return o - offset;
}

function rleCompressInto(out: Uint8Array | null, input: Uint8Array): number {
  const inLen = input.length;
  let p = 0;
  let copyStart = 0;
  let insertRun = 0;
  let copyRun = 0;
  let outWritten = 0;
  let lastByte = 0;
  while (p < inLen) {
    const c = input[p];
    if (insertRun === 0) {
      insertRun = 1;
    } else if (c === lastByte && insertRun < MAX_INSERT_RUN) {
      insertRun++;
    } else {
      if (isInsertRun(lastByte, insertRun)) {
        outWritten += copyRunEmit(out, outWritten, input, copyStart, copyRun);
        outWritten += insertRunEmit(out, outWritten, lastByte, insertRun);
        copyRun = 0;
        copyStart = p;
      } else {
        copyRun += insertRun;
      }
      insertRun = 1;
    }
    lastByte = c;
    p++;
  }
  if (isInsertRun(lastByte, insertRun)) {
    outWritten += copyRunEmit(out, outWritten, input, copyStart, copyRun);
    outWritten += insertRunEmit(out, outWritten, lastByte, insertRun);
  } else {
    outWritten += copyRunEmit(out, outWritten, input, copyStart, copyRun + insertRun);
  }
  return outWritten;
}

export function sasRleCompressedLen(input: Uint8Array): number {
  return rleCompressInto(null, input);
}

export function sasRleCompress(input: Uint8Array): Uint8Array {
  const len = rleCompressInto(null, input);
  const out = new Uint8Array(len);
  rleCompressInto(out, input);
  return out;
}
