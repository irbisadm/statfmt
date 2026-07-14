import { describe, it, expect } from "vitest";
import {
  ReadStatType,
  ReadStatMeasure,
  writeSav,
  writeDta,
  writeZsav,
  readSav,
  readDta,
  readData,
  detectFormat,
  type WriteSpec,
} from "../src/index.js";

const spec: WriteSpec = {
  fileLabel: "high-level test",
  timestamp: Math.floor(Date.UTC(2022, 5, 1, 12, 0, 0) / 1000),
  valueLabelSets: {
    yesno: [
      { value: 0, label: "No" },
      { value: 1, label: "Yes" },
    ],
  },
  variables: [
    { name: "id", type: ReadStatType.INT32, measure: ReadStatMeasure.SCALE },
    { name: "height", type: ReadStatType.DOUBLE, label: "Height (cm)" },
    { name: "active", type: ReadStatType.INT32, valueLabels: "yesno" },
    { name: "city", type: ReadStatType.STRING, storageWidth: 24 },
  ],
  rows: [
    [1, 172.5, 1, "München"],
    [2, 168.0, 0, "Paris"],
    [3, null, 1, "Zürich"],
  ],
};

describe("high-level API", () => {
  it("writeSav → readSav round-trip", () => {
    const bytes = writeSav(spec);
    expect(detectFormat(bytes)).toBe("sav");
    const ds = readSav(bytes);
    expect(ds.metadata.fileLabel).toBe("high-level test");
    expect(ds.variables.map((v) => v.name)).toEqual(["id", "height", "active", "city"]);
    expect(ds.variables[2].valueLabels).toEqual([
      { value: 0, label: "No" },
      { value: 1, label: "Yes" },
    ]);
    expect(ds.rows).toEqual([
      [1, 172.5, 1, "München"],
      [2, 168.0, 0, "Paris"],
      [3, null, 1, "Zürich"],
    ]);
    expect(ds.toObjects()[0]).toEqual({ id: 1, height: 172.5, active: 1, city: "München" });
  });

  it("writeZsav → readData round-trip", () => {
    const bytes = writeZsav(spec);
    const ds = readData("zsav", bytes);
    expect(ds.metadata.compression).toBe(2);
    expect(ds.rows[2]).toEqual([3, null, 1, "Zürich"]);
  });

  it("writeDta → readDta round-trip (v118)", () => {
    const bytes = writeDta({ ...spec, version: 118 });
    expect(detectFormat(bytes)).toBe("dta");
    const ds = readDta(bytes);
    expect(ds.rows).toEqual([
      [1, 172.5, 1, "München"],
      [2, 168.0, 0, "Paris"],
      [3, null, 1, "Zürich"],
    ]);
  });
});
