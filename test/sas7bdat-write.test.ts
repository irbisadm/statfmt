import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, ReadStatCompress, writeSas7bdat, readSas7bdat, type WriteSpec } from "../src/index.js";
import { hasReference, refToCsv, parseCsv, withTmpDir } from "./helpers/reference.js";

const spec: WriteSpec = {
  fileLabel: "sasdata",
  timestamp: Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000),
  variables: [
    { name: "id", type: ReadStatType.DOUBLE },
    { name: "score", type: ReadStatType.DOUBLE, format: "BEST12" },
    { name: "name", type: ReadStatType.STRING, storageWidth: 12, label: "Full name" },
  ],
  rows: [
    [1, 3.5, "Alice"],
    [2, 9.25, "Bob"],
    [3, null, "Carol"],
  ],
};

describe("SAS7BDAT writer", () => {
  for (const compression of [ReadStatCompress.NONE, ReadStatCompress.ROWS]) {
    const label = compression === ReadStatCompress.NONE ? "uncompressed" : "row-compressed";
    it(`round-trips through the TS reader (${label})`, () => {
      const bytes = writeSas7bdat({ ...spec, compression });
      const ds = readSas7bdat(bytes);
      expect(ds.variables.map((v) => v.name)).toEqual(["id", "score", "name"]);
      expect(ds.variables[2].label).toBe("Full name");
      expect(ds.rows[0]).toEqual([1, 3.5, "Alice"]);
      expect(ds.rows[1]).toEqual([2, 9.25, "Bob"]);
      expect(ds.rows[2][0]).toBe(3);
      expect(ds.rows[2][1]).toBe(null);
      expect(ds.rows[2][2]).toBe("Carol");
    });

    it.runIf(hasReference())(`is readable by the C library (${label})`, () => {
      const bytes = writeSas7bdat({ ...spec, compression });
      withTmpDir((dir) => {
        const file = join(dir, "out.sas7bdat");
        writeFileSync(file, bytes);
        const { header, rows } = parseCsv(refToCsv(file));
        expect(header).toEqual(["id", "score", "name"]);
        expect(rows.length).toBe(3);
        expect(Number(rows[0][0])).toBe(1);
        expect(Number(rows[1][1])).toBeCloseTo(9.25, 6);
        expect(rows[2][2]).toBe("Carol");
      });
    });
  }
});
