//
// value.ts — readstat_value_t (port of readstat_value.c)
//

import { ReadStatType, ReadStatTypeClass, readstatTypeClass } from "./types.js";

/**
 * A single cell value. Mirrors the C `readstat_value_t` union: numeric types
 * store into `num`, string types into `str`. `type` selects the interpretation.
 */
export class ReadStatValue {
  type: ReadStatType;
  tag: string; // '' if none, otherwise a single character
  isSystemMissing: boolean;
  isTaggedMissing: boolean;
  num: number; // numeric payload
  str: string | null; // string payload

  constructor(type: ReadStatType) {
    this.type = type;
    this.tag = "";
    this.isSystemMissing = false;
    this.isTaggedMissing = false;
    this.num = 0;
    this.str = null;
  }

  typeClass(): ReadStatTypeClass {
    return readstatTypeClass(this.type);
  }

  int8Value(): number {
    if (this.isSystemMissing) return 0;
    switch (this.type) {
      case ReadStatType.DOUBLE:
      case ReadStatType.FLOAT:
      case ReadStatType.INT32:
      case ReadStatType.INT16:
        return (Math.trunc(this.num) << 24) >> 24;
      case ReadStatType.INT8:
        return this.num;
      default:
        return 0;
    }
  }
  int16Value(): number {
    if (this.isSystemMissing) return 0;
    switch (this.type) {
      case ReadStatType.DOUBLE:
      case ReadStatType.FLOAT:
      case ReadStatType.INT32:
        return (Math.trunc(this.num) << 16) >> 16;
      case ReadStatType.INT16:
      case ReadStatType.INT8:
        return this.num;
      default:
        return 0;
    }
  }
  int32Value(): number {
    if (this.isSystemMissing) return 0;
    switch (this.type) {
      case ReadStatType.DOUBLE:
      case ReadStatType.FLOAT:
        return Math.trunc(this.num) | 0;
      case ReadStatType.INT32:
      case ReadStatType.INT16:
      case ReadStatType.INT8:
        return this.num;
      default:
        return 0;
    }
  }
  floatValue(): number {
    if (this.isSystemMissing) return NaN;
    switch (this.type) {
      case ReadStatType.DOUBLE:
        return Math.fround(this.num);
      case ReadStatType.FLOAT:
      case ReadStatType.INT32:
      case ReadStatType.INT16:
      case ReadStatType.INT8:
        return this.num;
      default:
        return this.num;
    }
  }
  doubleValue(): number {
    if (this.isSystemMissing) return NaN;
    switch (this.type) {
      case ReadStatType.DOUBLE:
      case ReadStatType.FLOAT:
      case ReadStatType.INT32:
      case ReadStatType.INT16:
      case ReadStatType.INT8:
        return this.num;
      default:
        return NaN;
    }
  }
  stringValue(): string | null {
    if (this.type === ReadStatType.STRING) return this.str;
    return null;
  }

  // Convenience: a plain JS value for high-level APIs.
  toJS(): number | string | null {
    if (this.isSystemMissing || this.isTaggedMissing) return null;
    if (this.type === ReadStatType.STRING) return this.str;
    return this.num;
  }
}

// ---- Factory helpers (mirror the static make_* helpers in the C sources) ----

export function makeBlankValue(): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.DOUBLE);
  v.isSystemMissing = true;
  v.num = NaN;
  return v;
}

export function makeBlankTaggedValue(tag: string): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.DOUBLE);
  v.isSystemMissing = true;
  v.isTaggedMissing = true;
  v.tag = tag;
  v.num = NaN;
  return v;
}

export function makeDoubleValue(d: number): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.DOUBLE);
  v.num = d;
  if (Number.isNaN(d)) v.isSystemMissing = true;
  return v;
}

export function makeFloatValue(f: number): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.FLOAT);
  v.num = f;
  if (Number.isNaN(f)) v.isSystemMissing = true;
  return v;
}

export function makeInt8Value(i: number): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.INT8);
  v.num = i;
  return v;
}

export function makeInt16Value(i: number): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.INT16);
  v.num = i;
  return v;
}

export function makeInt32Value(i: number): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.INT32);
  v.num = i;
  return v;
}

export function makeStringValue(s: string | null): ReadStatValue {
  const v = new ReadStatValue(ReadStatType.STRING);
  v.str = s;
  return v;
}
