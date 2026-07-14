//
// io.ts — IO abstraction (port of readstat_io_t / readstat_io_unistd.c)
//
// The C library reads sequentially with seek support via file descriptors.
// Since data files comfortably fit in memory, the default implementation
// operates over an in-memory Uint8Array, which makes seeking trivial and
// keeps parsing fully synchronous.
//

import { ReadStatSeek } from "./types.js";

export interface IoContext {
  /** Read up to `nbyte` bytes at the current cursor; returns actual bytes (may be shorter at EOF). */
  read(nbyte: number): Uint8Array;
  /** Move the cursor. Returns the new absolute offset, or -1 on error. */
  seek(offset: number, whence: ReadStatSeek): number;
  /** Current absolute offset. */
  tell(): number;
  /** Total size in bytes. */
  size(): number;
}

/** In-memory IO context backed by a Uint8Array. */
export class BufferIoContext implements IoContext {
  private data: Uint8Array;
  private cursor = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  read(nbyte: number): Uint8Array {
    const end = Math.min(this.cursor + nbyte, this.data.length);
    const out = this.data.subarray(this.cursor, end);
    this.cursor = end;
    return out;
  }

  seek(offset: number, whence: ReadStatSeek): number {
    let base = 0;
    switch (whence) {
      case ReadStatSeek.SET:
        base = 0;
        break;
      case ReadStatSeek.CUR:
        base = this.cursor;
        break;
      case ReadStatSeek.END:
        base = this.data.length;
        break;
      default:
        return -1;
    }
    const next = base + offset;
    if (next < 0) return -1;
    this.cursor = next;
    return this.cursor;
  }

  tell(): number {
    return this.cursor;
  }

  size(): number {
    return this.data.length;
  }
}

/**
 * Read exactly `nbyte` bytes or throw. Mirrors the ubiquitous
 * `if (io->read(...) < len) { retval = READSTAT_ERROR_READ; }` pattern.
 * Returns a fresh copy so callers may retain it safely.
 */
export function ioReadExact(io: IoContext, nbyte: number): Uint8Array {
  const chunk = io.read(nbyte);
  if (chunk.length < nbyte) {
    throw new IoReadError(nbyte, chunk.length);
  }
  // subarray view -> copy so downstream mutation/retention is safe
  return chunk.slice();
}

export class IoReadError extends Error {
  constructor(wanted: number, got: number) {
    super(`Unable to read from file (wanted ${wanted} bytes, got ${got})`);
    this.name = "IoReadError";
  }
}
