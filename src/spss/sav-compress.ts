//
// spss/sav-compress.ts — SAV bytecode row compression
// (port of readstat_sav_compress.c)
//

import { Writer } from "../writer.js";
import { ReadStatType } from "../types.js";
import { SAV_MISSING_DOUBLE } from "./spss.js";

const EIGHT_SPACES = new Uint8Array([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);

export function savCompressedRowBound(uncompressedLength: number): number {
  return uncompressedLength + Math.floor((Math.floor(uncompressedLength / 8) + 8) / 8) * 8;
}

/** Compress one row; returns the compressed length written into `output`. */
export function savCompressRow(output: Uint8Array, input: Uint8Array, writer: Writer): number {
  let inputOffset = 0;
  let outputOffset = 8;
  let controlOffset = 0;

  output.fill(0, 0, 8);
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);

  for (let i = 0; i < writer.variables.length; i++) {
    const variable = writer.variables[i];
    if (variable.type === ReadStatType.STRING) {
      let width = variable.storageWidth;
      while (width > 0) {
        if (memcmp8(input, inputOffset, EIGHT_SPACES, 0)) {
          output[controlOffset++] = 254;
        } else {
          output[controlOffset++] = 253;
          output.set(input.subarray(inputOffset, inputOffset + 8), outputOffset);
          outputOffset += 8;
        }
        if (controlOffset % 8 === 0) {
          controlOffset = outputOffset;
          output.fill(0, controlOffset, controlOffset + 8);
          outputOffset += 8;
        }
        inputOffset += 8;
        width -= 8;
      }
    } else {
      const intValue = dv.getBigUint64(inputOffset, true);
      if (intValue === SAV_MISSING_DOUBLE) {
        output[controlOffset++] = 255;
      } else {
        const fpValue = dv.getFloat64(inputOffset, true);
        if (fpValue > -100 && fpValue < 152 && Math.trunc(fpValue) === fpValue) {
          output[controlOffset++] = fpValue + 100;
        } else {
          output[controlOffset++] = 253;
          output.set(input.subarray(inputOffset, inputOffset + 8), outputOffset);
          outputOffset += 8;
        }
      }
      if (controlOffset % 8 === 0) {
        controlOffset = outputOffset;
        output.fill(0, controlOffset, controlOffset + 8);
        outputOffset += 8;
      }
      inputOffset += 8;
    }
  }

  if (writer.currentRow + 1 === writer.rowCount) {
    output[controlOffset] = 252;
  }

  return outputOffset;
}

function memcmp8(a: Uint8Array, ao: number, b: Uint8Array, bo: number): boolean {
  for (let i = 0; i < 8; i++) {
    if (a[ao + i] !== b[bo + i]) return false;
  }
  return true;
}

// ---- streaming decompressor (used by the reader) ----

export enum SavRowStreamStatus {
  NEED_DATA,
  HAVE_DATA,
  FINISHED_ROW,
  FINISHED_ALL,
}

export class SavRowStream {
  nextIn: Uint8Array; // remaining compressed bytes
  inPos = 0;
  avail_in: number;

  out: Uint8Array; // destination row buffer
  outPos = 0;
  avail_out: number;

  missingValue: bigint;
  bias: number;

  chunk = new Uint8Array(8);
  i = 8;
  /** File byte order: true = little-endian. */
  le: boolean;

  status: SavRowStreamStatus = SavRowStreamStatus.NEED_DATA;

  constructor(missingValue: bigint, bias: number, le: boolean) {
    this.missingValue = missingValue;
    this.bias = bias;
    this.le = le;
    this.nextIn = new Uint8Array(0);
    this.avail_in = 0;
    this.out = new Uint8Array(0);
    this.avail_out = 0;
  }

  setInput(bytes: Uint8Array): void {
    this.nextIn = bytes;
    this.inPos = 0;
    this.avail_in = bytes.length;
  }

  setOutput(out: Uint8Array): void {
    this.out = out;
    this.outPos = 0;
    this.avail_out = out.length;
  }
}

export function savDecompressRow(state: SavRowStream): void {
  const missingBytes = new Uint8Array(8);
  new DataView(missingBytes.buffer).setBigUint64(0, state.missingValue, state.le);
  const outDv = new DataView(state.out.buffer, state.out.byteOffset, state.out.byteLength);

  let i = 8 - state.i;
  loop: while (true) {
    if (i === 8) {
      if (state.avail_in < 8) {
        state.status = SavRowStreamStatus.NEED_DATA;
        break;
      }
      state.chunk.set(state.nextIn.subarray(state.inPos, state.inPos + 8));
      state.inPos += 8;
      state.avail_in -= 8;
      i = 0;
    }
    while (i < 8) {
      const code = state.chunk[i];
      switch (code) {
        case 0:
          break;
        case 252:
          state.status = SavRowStreamStatus.FINISHED_ALL;
          break loop;
        case 253:
          if (state.avail_in < 8) {
            state.status = SavRowStreamStatus.NEED_DATA;
            break loop;
          }
          state.out.set(state.nextIn.subarray(state.inPos, state.inPos + 8), state.outPos);
          state.outPos += 8;
          state.avail_out -= 8;
          state.inPos += 8;
          state.avail_in -= 8;
          break;
        case 254:
          state.out.fill(0x20, state.outPos, state.outPos + 8);
          state.outPos += 8;
          state.avail_out -= 8;
          break;
        case 255:
          state.out.set(missingBytes, state.outPos);
          state.outPos += 8;
          state.avail_out -= 8;
          break;
        default: {
          const fpValue = code - state.bias;
          outDv.setFloat64(state.outPos, fpValue, state.le);
          state.outPos += 8;
          state.avail_out -= 8;
          break;
        }
      }
      i++;
      if (state.avail_out < 8) {
        state.status = SavRowStreamStatus.FINISHED_ROW;
        break loop;
      }
    }
  }
  state.i = 8 - i;
}
