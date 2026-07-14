//
// sas/ieee.ts — IEEE <-> SAS transport (IBM hex) floating-point conversion
// (port of ieee.c, itself derived from SAS Technical Note TS-140)
//
// The C code operates on native-order 32-bit halves via memreverse(); this
// port works directly on big-endian 32-bit values so it is machine-independent.
//

function u32be(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}
function putU32be(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

/** Convert 8 SAS-transport (IBM) bytes to 8 big-endian IEEE-754 bytes. */
export function xptToIeeeBytes(xport: Uint8Array): Uint8Array {
  const ieee = new Uint8Array(8);
  const t0 = xport[0];

  // SAS special missing values: first byte set, remaining seven zero.
  let restZero = true;
  for (let i = 1; i < 8; i++) if (xport[i] !== 0) { restZero = false; break; }
  if (t0 && restZero) {
    ieee[0] = ieee[1] = 0xff;
    ieee[2] = ~t0 & 0xff;
    return ieee;
  }

  const xport1 = u32be(xport, 0);
  const xport2 = u32be(xport, 4);
  let ieee1 = 0;
  let ieee2 = 0;

  if (((xport1 & 0x7fffffff) >>> 0) === 0x7fffffff && xport2 === 0xffffffff) {
    ieee1 = (((xport1 & 0x80000000) >>> 0) | 0x7ff00000) >>> 0;
    ieee2 = 0;
  } else {
    ieee1 = xport1 & 0x00ffffff;
    ieee2 = xport2 >>> 0;
    if (ieee2 === 0 && xport1 === 0) {
      return ieee; // zero
    }
    let shift: number;
    if (xport1 & 0x00800000) shift = 3;
    else if (xport1 & 0x00400000) shift = 2;
    else if (xport1 & 0x00200000) shift = 1;
    else shift = 0;
    if (shift) {
      ieee1 = ieee1 >>> shift;
      ieee2 = ((xport2 >>> shift) | ((xport1 & 0x00000007) << (29 + (3 - shift)))) >>> 0;
    }
    ieee1 = (ieee1 & 0xffefffff) >>> 0;
    const expPart = ((((t0 & 0x7f) - 65) * 4) + shift + 1023) & 0xffffffff;
    ieee1 = (ieee1 | ((expPart << 20) >>> 0) | (xport1 & 0x80000000)) >>> 0;
  }

  putU32be(ieee, 0, ieee1);
  putU32be(ieee, 4, ieee2);
  return ieee;
}

/** Convert 8 big-endian IEEE-754 bytes to 8 SAS-transport (IBM) bytes. */
export function ieeeToXptBytes(ieee: Uint8Array): Uint8Array {
  const xport = new Uint8Array(8);
  const i0 = ieee[0];
  const i1 = ieee[1];
  const i2 = ieee[2];

  if (i0 === 0xff && i1 === 0xff) {
    const misschar = ~i2 & 0xff;
    xport[0] = misschar === 0xd2 ? 0x6d : misschar;
    return xport;
  }

  const ieee1 = u32be(ieee, 0);
  const ieee2 = u32be(ieee, 4);
  let xport1 = ieee1 & 0x000fffff;
  let xport2 = ieee2 >>> 0;
  let ieeeExp = 0;

  if (xport2 === 0 && ieee1 === 0) {
    ieeeExp = 0;
  } else {
    ieeeExp = (((ieee1 >>> 16) & 0x7ff0) >> 4) - 1023;
    const shift = ieeeExp & 3;
    xport1 = (xport1 | 0x00100000) >>> 0;
    if (shift) {
      xport1 = ((xport1 << shift) | (((ieee2 >>> 24) & 0xe0) >> (5 + (3 - shift)))) >>> 0;
      xport2 = (xport2 << shift) >>> 0;
    }
    xport1 = (xport1 | ((((ieeeExp >> 2) + 65) | ((ieee1 >>> 24) & 0x80)) << 24)) >>> 0;
  }

  if (ieeeExp < -260) {
    xport.fill(0);
  } else if (ieeeExp > 248) {
    xport.fill(0xff, 1, 8);
    xport[0] = (0x7f | ((ieee1 >>> 24) & 0x80)) & 0xff;
  } else {
    putU32be(xport, 0, xport1);
    putU32be(xport, 4, xport2);
  }
  return xport;
}

/** Read an XPORT double, returning the value plus any SAS missing tag. */
export function xptToDouble(xport: Uint8Array, off = 0): { value: number; missing: boolean; tag: string } {
  const slice = xport.subarray(off, off + 8);
  const ieee = xptToIeeeBytes(slice);
  if (ieee[0] === 0xff && ieee[1] === 0xff) {
    // special missing; ieee[2] = ~firstByte
    const marker = ~ieee[2] & 0xff;
    // '.' => 0x2E plain missing; letters/underscore => tagged
    const tag = marker >= 0x41 && marker <= 0x5a ? String.fromCharCode(marker + 0x20) : "";
    return { value: NaN, missing: true, tag };
  }
  const dv = new DataView(ieee.buffer, ieee.byteOffset, 8);
  return { value: dv.getFloat64(0, false), missing: false, tag: "" };
}

/** Encode a JS double as 8 XPORT bytes. */
export function doubleToXpt(value: number): Uint8Array {
  const ieee = new Uint8Array(8);
  new DataView(ieee.buffer).setFloat64(0, value, false);
  return ieeeToXptBytes(ieee);
}
