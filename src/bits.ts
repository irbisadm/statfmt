//
// bits.ts — Bit-twiddling utilities (port of readstat_bits.c)
//

/** The host machine is virtually always little-endian for our purposes, but we
 *  never actually rely on host endianness because all parsing goes through
 *  explicit little/big-endian DataView reads. */
export function machineIsLittleEndian(): boolean {
  const buf = new Uint8Array(new Uint16Array([1]).buffer);
  return buf[0] === 1;
}

// One's / two's complement conversions used by the Stata (DTA) reader/writer.
export function onesToTwosComplement1(num: number): number {
  const v = int8(num);
  return v < 0 ? int8(v + 1) : v;
}
export function onesToTwosComplement2(num: number): number {
  const v = int16(num);
  return v < 0 ? int16(v + 1) : v;
}
export function onesToTwosComplement4(num: number): number {
  const v = int32(num);
  return v < 0 ? int32(v + 1) : v;
}
export function twosToOnesComplement1(num: number): number {
  const v = int8(num);
  return v < 0 ? int8(v - 1) : v;
}
export function twosToOnesComplement2(num: number): number {
  const v = int16(num);
  return v < 0 ? int16(v - 1) : v;
}
export function twosToOnesComplement4(num: number): number {
  const v = int32(num);
  return v < 0 ? int32(v - 1) : v;
}

// Signed truncation helpers replicating C integer casts.
export function int8(num: number): number {
  return (num << 24) >> 24;
}
export function int16(num: number): number {
  return (num << 16) >> 16;
}
export function int32(num: number): number {
  return num | 0;
}
export function uint8(num: number): number {
  return num & 0xff;
}
export function uint16(num: number): number {
  return num & 0xffff;
}
export function uint32(num: number): number {
  return num >>> 0;
}

export function byteswap2(num: number): number {
  return (((num & 0xff00) >> 8) | ((num & 0x00ff) << 8)) & 0xffff;
}
export function byteswap4(num: number): number {
  num = num >>> 0;
  num = ((num & 0xffff0000) >>> 16) | ((num & 0x0000ffff) << 16);
  return (((num & 0xff00ff00) >>> 8) | ((num & 0x00ff00ff) << 8)) >>> 0;
}
export function byteswap8(num: bigint): bigint {
  const mask8 = 0xffffffffffffffffn;
  num &= mask8;
  num = ((num & 0xffffffff00000000n) >> 32n) | ((num & 0x00000000ffffffffn) << 32n);
  num = ((num & 0xffff0000ffff0000n) >> 16n) | ((num & 0x0000ffff0000ffffn) << 16n);
  num = ((num & 0xff00ff00ff00ff00n) >> 8n) | ((num & 0x00ff00ff00ff00ffn) << 8n);
  return num & mask8;
}
