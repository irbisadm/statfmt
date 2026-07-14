import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSas7bdat, detectFormat } from "../src/index.js";
import { buildSampleSav } from "./helpers/build-sav.js";
import { hasReference, refConvert, withTmpDir } from "./helpers/reference.js";

describe.runIf(hasReference())("SAS7BDAT reader (C-produced files)", () => {
  it("reads a sas7bdat converted from our SAV by the C library", () => {
    const sav = buildSampleSav();
    withTmpDir((dir) => {
      const savFile = join(dir, "in.sav");
      const sasFile = join(dir, "out.sas7bdat");
      writeFileSync(savFile, sav);
      refConvert(savFile, sasFile);

      const bytes = readFileSync(sasFile);
      expect(detectFormat(bytes)).toBe("sas7bdat");
      const ds = readSas7bdat(bytes);
      expect(ds.variables.map((v) => v.name)).toEqual(["id", "score", "grp", "name"]);
      expect(ds.rows[0]).toEqual([1, 3.5, 1, "Alice"]);
      expect(ds.rows[1]).toEqual([2, 9.25, 2, "Bob"]);
      expect(ds.rows[2][0]).toBe(3);
      expect(ds.rows[2][3]).toBe("Cörnelius");
    });
  });

  it("reads a row-compressed sas7bdat", () => {
    const sav = buildSampleSav();
    withTmpDir((dir) => {
      const savFile = join(dir, "in.sav");
      const sasFile = join(dir, "out.sas7bdat");
      writeFileSync(savFile, sav);
      // C readstat compresses sas7bdat rows by default in conversions
      refConvert(savFile, sasFile);
      const ds = readSas7bdat(readFileSync(sasFile));
      expect(ds.rows.length).toBe(3);
    });
  });
});
