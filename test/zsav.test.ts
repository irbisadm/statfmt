import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSavModel } from "./helpers/model.js";
import { buildSampleSav } from "./helpers/build-sav.js";
import { hasReference, refToCsv, parseCsv, withTmpDir } from "./helpers/reference.js";

describe("ZSAV (binary/zlib compression)", () => {
  it("round-trips through the TS reader", () => {
    const bytes = buildSampleSav({ compress: 2 });
    const model = readSavModel(bytes);
    expect(model.metadata?.compression).toBe(2);
    expect(model.metadata?.fileFormatVersion).toBe(3);
    expect(model.rows).toEqual([
      [1, 3.5, 1, "Alice"],
      [2, 9.25, 2, "Bob"],
      [3, null, 1, "Cörnelius"],
    ]);
  });

  it("produces a ZSAV the C library can read", () => {
    if (!hasReference()) return;
    const bytes = buildSampleSav({ compress: 2 });
    withTmpDir((dir) => {
      const file = join(dir, "out.zsav");
      writeFileSync(file, bytes);
      const { header, rows } = parseCsv(refToCsv(file));
      expect(header).toEqual(["id", "score", "grp", "name"]);
      expect(rows.length).toBe(3);
      expect(Number(rows[0][0])).toBe(1);
      expect(Number(rows[1][1])).toBeCloseTo(9.25, 6);
      expect(rows[2][3]).toBe("Cörnelius");
    });
  });
});
