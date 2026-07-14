//
// binary.ts — Endian-aware binary reader/writer over Uint8Array
//

/** Cursor-based reader over a byte buffer with a configurable default endianness. */
export class BinaryReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  le: boolean;
  pos: number;

  constructor(bytes: Uint8Array, littleEndian = true, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.le = littleEndian;
    this.pos = offset;
  }

  get length(): number {
    return this.bytes.length;
  }
  remaining(): number {
    return this.bytes.length - this.pos;
  }
  tell(): number {
    return this.pos;
  }
  seek(pos: number): void {
    this.pos = pos;
  }
  skip(n: number): void {
    this.pos += n;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    return this.view.getInt8(this.pos++);
  }
  u16(le = this.le): number {
    const v = this.view.getUint16(this.pos, le);
    this.pos += 2;
    return v;
  }
  i16(le = this.le): number {
    const v = this.view.getInt16(this.pos, le);
    this.pos += 2;
    return v;
  }
  u32(le = this.le): number {
    const v = this.view.getUint32(this.pos, le);
    this.pos += 4;
    return v;
  }
  i32(le = this.le): number {
    const v = this.view.getInt32(this.pos, le);
    this.pos += 4;
    return v;
  }
  u64(le = this.le): bigint {
    const v = this.view.getBigUint64(this.pos, le);
    this.pos += 8;
    return v;
  }
  i64(le = this.le): bigint {
    const v = this.view.getBigInt64(this.pos, le);
    this.pos += 8;
    return v;
  }
  f32(le = this.le): number {
    const v = this.view.getFloat32(this.pos, le);
    this.pos += 4;
    return v;
  }
  f64(le = this.le): number {
    const v = this.view.getFloat64(this.pos, le);
    this.pos += 8;
    return v;
  }
  /** Read `n` bytes as a copy. */
  bytes_(n: number): Uint8Array {
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** Read `n` bytes as a view (no copy). */
  view_(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Growable binary writer with a configurable default endianness. */
export class BinaryWriter {
  private buf: Uint8Array;
  private dv: DataView;
  private len: number;
  le: boolean;

  constructor(littleEndian = true, capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.dv = new DataView(this.buf.buffer);
    this.len = 0;
    this.le = littleEndian;
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.dv.setUint8(this.len, v & 0xff);
    this.len += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.dv.setInt8(this.len, v);
    this.len += 1;
    return this;
  }
  u16(v: number, le = this.le): this {
    this.ensure(2);
    this.dv.setUint16(this.len, v & 0xffff, le);
    this.len += 2;
    return this;
  }
  i16(v: number, le = this.le): this {
    this.ensure(2);
    this.dv.setInt16(this.len, v, le);
    this.len += 2;
    return this;
  }
  u32(v: number, le = this.le): this {
    this.ensure(4);
    this.dv.setUint32(this.len, v >>> 0, le);
    this.len += 4;
    return this;
  }
  i32(v: number, le = this.le): this {
    this.ensure(4);
    this.dv.setInt32(this.len, v | 0, le);
    this.len += 4;
    return this;
  }
  u64(v: bigint, le = this.le): this {
    this.ensure(8);
    this.dv.setBigUint64(this.len, v, le);
    this.len += 8;
    return this;
  }
  i64(v: bigint, le = this.le): this {
    this.ensure(8);
    this.dv.setBigInt64(this.len, v, le);
    this.len += 8;
    return this;
  }
  f32(v: number, le = this.le): this {
    this.ensure(4);
    this.dv.setFloat32(this.len, v, le);
    this.len += 4;
    return this;
  }
  f64(v: number, le = this.le): this {
    this.ensure(8);
    this.dv.setFloat64(this.len, v, le);
    this.len += 8;
    return this;
  }
  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
    return this;
  }
  zeros(n: number): this {
    if (n <= 0) return this;
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }
  /** Pad with byte `b` up to total length `n` from current position marker `from`. */
  fill(b: number, n: number): this {
    if (n <= 0) return this;
    this.ensure(n);
    this.buf.fill(b & 0xff, this.len, this.len + n);
    this.len += n;
    return this;
  }

  /** Overwrite bytes at absolute position (must already be within written range). */
  patchU32(at: number, v: number, le = this.le): void {
    this.dv.setUint32(at, v >>> 0, le);
  }
  patchBytes(at: number, data: Uint8Array): void {
    this.buf.set(data, at);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
