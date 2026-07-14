import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, writePor, readPor, type WriteSpec } from "../src/index.js";
import { hasReference, refToCsv, parseCsv, withTmpDir } from "./helpers/reference.js";

const spec: WriteSpec = {
  fileLabel: "PORTEST",
  timestamp: Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000),
  valueLabelSets: {
    SEX: [
      { value: 1, label: "Male" },
      { value: 2, label: "Female" },
    ],
  },
  variables: [
    { name: "ID", type: ReadStatType.INT32 },
    { name: "SCORE", type: ReadStatType.DOUBLE, label: "Test score" },
    { name: "GRP", type: ReadStatType.INT32, valueLabels: "SEX" },
    { name: "NAME", type: ReadStatType.STRING, storageWidth: 16 },
  ],
  rows: [
    [1, 3.5, 1, "Alice"],
    [2, 9.25, 2, "Bob"],
    [3, null, 1, "Carol"],
  ],
};

describe("POR writer", () => {
  it("round-trips through the TS reader", () => {
    const bytes = writePor(spec);
    const ds = readPor(bytes);
    expect(ds.variables.map((v) => v.name)).toEqual(["ID", "SCORE", "GRP", "NAME"]);
    expect(ds.variables[1].label).toBe("Test score");
    expect(ds.rows[0]).toEqual([1, 3.5, 1, "Alice"]);
    expect(ds.rows[1]).toEqual([2, 9.25, 2, "Bob"]);
    expect(ds.rows[2][0]).toBe(3);
    expect(ds.rows[2][1]).toBe(null);
    expect(ds.rows[2][3]).toBe("Carol");
    const grpLabels = ds.variables[2].valueLabels;
    expect(grpLabels).toEqual([
      { value: 1, label: "Male" },
      { value: 2, label: "Female" },
    ]);
  });

  it.runIf(hasReference())("is readable by the C library", () => {
    const bytes = writePor(spec);
    withTmpDir((dir) => {
      const file = join(dir, "out.por");
      writeFileSync(file, bytes);
      const { header, rows } = parseCsv(refToCsv(file));
      expect(header).toEqual(["ID", "SCORE", "GRP", "NAME"]);
      expect(rows.length).toBe(3);
      expect(Number(rows[0][0])).toBe(1);
      expect(Number(rows[1][1])).toBeCloseTo(9.25, 6);
      expect(rows[2][3]).toBe("Carol");
    });
  });
});
