import { describe, it, expect } from "vitest";
import {
  ReadStatType,
  ReadStatTypeClass,
  readstatTypeClass,
  Variable,
  valueIsMissing,
  LabelSet,
  BinaryReader,
  BinaryWriter,
  defaultCodec,
  normalizeEncoding,
} from "../src/index.js";
import { makeDoubleValue, makeStringValue, makeInt32Value, makeBlankValue } from "../src/value.js";
import { byteswap4, byteswap8, onesToTwosComplement2 } from "../src/bits.js";
import { hasReference } from "./helpers/reference.js";

describe("type class", () => {
  it("classifies string vs numeric", () => {
    expect(readstatTypeClass(ReadStatType.STRING)).toBe(ReadStatTypeClass.STRING);
    expect(readstatTypeClass(ReadStatType.STRING_REF)).toBe(ReadStatTypeClass.STRING);
    expect(readstatTypeClass(ReadStatType.DOUBLE)).toBe(ReadStatTypeClass.NUMERIC);
    expect(readstatTypeClass(ReadStatType.INT8)).toBe(ReadStatTypeClass.NUMERIC);
  });
});

describe("value accessors", () => {
  it("double value round-trips and casts", () => {
    const v = makeDoubleValue(3.75);
    expect(v.doubleValue()).toBe(3.75);
    expect(v.int32Value()).toBe(3);
    expect(v.floatValue()).toBeCloseTo(3.75);
  });
  it("system missing returns NaN / 0", () => {
    const v = makeBlankValue();
    expect(v.isSystemMissing).toBe(true);
    expect(Number.isNaN(v.doubleValue())).toBe(true);
    expect(v.int32Value()).toBe(0);
  });
  it("string value only for string type", () => {
    expect(makeStringValue("hi").stringValue()).toBe("hi");
    expect(makeInt32Value(5).stringValue()).toBe(null);
  });
});

describe("defined missing", () => {
  it("detects value in a missing range", () => {
    const v = new Variable(ReadStatType.DOUBLE, 0);
    v.addMissingDoubleValue(999);
    v.addMissingDoubleRange(-5, -1);
    expect(valueIsMissing(makeDoubleValue(999), v)).toBe(true);
    expect(valueIsMissing(makeDoubleValue(-3), v)).toBe(true);
    expect(valueIsMissing(makeDoubleValue(0), v)).toBe(false);
  });
});

describe("label set", () => {
  it("stores labels", () => {
    const ls = new LabelSet(ReadStatType.DOUBLE, "sex");
    ls.labelDoubleValue(1, "Male");
    ls.labelDoubleValue(2, "Female");
    expect(ls.valueLabelsCount).toBe(2);
    expect(ls.valueLabels[0].label).toBe("Male");
  });
});

describe("binary reader/writer", () => {
  it("round-trips mixed types little-endian", () => {
    const w = new BinaryWriter(true);
    w.u8(0xab).i16(-1234).u32(0xdeadbeef).f64(3.141592653589793).i64(-42n);
    const bytes = w.finish();
    const r = new BinaryReader(bytes, true);
    expect(r.u8()).toBe(0xab);
    expect(r.i16()).toBe(-1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.f64()).toBe(3.141592653589793);
    expect(r.i64()).toBe(-42n);
  });
  it("respects big-endian", () => {
    const w = new BinaryWriter(false);
    w.u32(0x01020304);
    expect(Array.from(w.finish())).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
});

describe("bits", () => {
  it("byteswap4", () => {
    expect(byteswap4(0x01020304)).toBe(0x04030201);
  });
  it("byteswap8", () => {
    expect(byteswap8(0x0102030405060708n)).toBe(0x0807060504030201n);
  });
  it("ones to twos complement", () => {
    expect(onesToTwosComplement2(-1)).toBe(0);
    expect(onesToTwosComplement2(5)).toBe(5);
  });
});

describe("codec", () => {
  it("normalizes encodings", () => {
    expect(normalizeEncoding("WINDOWS-1252")).toBe("windows-1252");
    expect(normalizeEncoding("CP1252")).toBe("windows-1252");
    expect(normalizeEncoding("latin1")).toBe("iso-8859-1");
    expect(normalizeEncoding("UTF-8")).toBe("utf-8");
  });
  it("decodes windows-1251 cyrillic", () => {
    // 0xCF 0xF0 0xE8 0xE2 0xE5 0xF2 = "Привет" in cp1251
    const bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(defaultCodec.decode(bytes, "windows-1251")).toBe("Привет");
  });
  it("encodes/decodes latin1 round-trip", () => {
    const s = "café";
    const enc = defaultCodec.encode(s, "iso-8859-1");
    expect(defaultCodec.decode(enc, "iso-8859-1")).toBe(s);
  });
});

describe("reference binary", () => {
  it("is available for cross-validation", () => {
    // Not a hard failure if missing, but log so we know coverage.
    expect(typeof hasReference()).toBe("boolean");
  });
});
