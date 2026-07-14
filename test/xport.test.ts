import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, writeXport, readXport, detectFormat, type WriteSpec } from "../src/index.js";
import { hasReference, refToCsv, parseCsv, refConvert, withTmpDir } from "./helpers/reference.js";
import { buildSampleSav } from "./helpers/build-sav.js";

const spec: WriteSpec = {
  fileLabel: "XPTTEST",
  timestamp: Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000),
  variables: [
    { name: "ID", type: ReadStatType.DOUBLE },
    { name: "SCORE", type: ReadStatType.DOUBLE, format: "8.2" },
    { name: "NAME", type: ReadStatType.STRING, storageWidth: 12 },
  ],
  rows: [
    [1, 3.5, "Alice"],
    [2, 9.25, "Bob"],
    [3, null, "Carol"],
  ],
};

describe("XPORT writer/reader", () => {
  for (const version of [8, 5]) {
    it(`round-trips through the TS reader (v${version})`, () => {
      const bytes = writeXport({ ...spec, version });
      expect(detectFormat(bytes)).toBe("xport");
      const ds = readXport(bytes);
      expect(ds.variables.map((v) => v.name)).toEqual(["ID", "SCORE", "NAME"]);
      expect(ds.rows[0]).toEqual([1, 3.5, "Alice"]);
      expect(ds.rows[1]).toEqual([2, 9.25, "Bob"]);
      expect(ds.rows[2][0]).toBe(3);
      expect(ds.rows[2][1]).toBe(null);
      expect(ds.rows[2][2]).toBe("Carol");
    });

    it.runIf(hasReference())(`is readable by the C library (v${version})`, () => {
      const bytes = writeXport({ ...spec, version });
      withTmpDir((dir) => {
        const file = join(dir, "out.xpt");
        writeFileSync(file, bytes);
        const { header, rows } = parseCsv(refToCsv(file));
        expect(header).toEqual(["ID", "SCORE", "NAME"]);
        expect(rows.length).toBe(3);
        expect(Number(rows[0][0])).toBe(1);
        expect(Number(rows[1][1])).toBeCloseTo(9.25, 2);
        expect(rows[2][2]).toBe("Carol");
      });
    });
  }
});

describe.runIf(hasReference())("XPORT reader (C-produced file)", () => {
  it("reads an XPORT converted from a SAV by the C library", () => {
    const sav = buildSampleSav();
    withTmpDir((dir) => {
      const savFile = join(dir, "in.sav");
      const xptFile = join(dir, "out.xpt");
      writeFileSync(savFile, sav);
      refConvert(savFile, xptFile);
      const ds = readXport(readFileSync(xptFile));
      expect(ds.rows[0][0]).toBe(1);
      expect(ds.rows[1][1]).toBeCloseTo(9.25, 6);
    });
  });
});
