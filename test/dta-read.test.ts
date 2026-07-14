import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatParser } from "../src/parser.js";
import { BufferIoContext } from "../src/io.js";
import { parseDta } from "../src/stata/dta-read.js";
import { newModel, wireModel } from "./helpers/model.js";
import { buildSampleSav } from "./helpers/build-sav.js";
import { hasReference, refConvert, withTmpDir } from "./helpers/reference.js";

function readDtaModel(bytes: Uint8Array) {
  const parser = new ReadStatParser();
  const model = newModel();
  wireModel(parser, model);
  parseDta(parser, new BufferIoContext(bytes), null);
  return model;
}

describe.runIf(hasReference())("DTA reader (C-produced files)", () => {
  it("reads a DTA converted from our SAV by the C library", () => {
    const sav = buildSampleSav();
    withTmpDir((dir) => {
      const savFile = join(dir, "in.sav");
      const dtaFile = join(dir, "out.dta");
      writeFileSync(savFile, sav);
      refConvert(savFile, dtaFile);

      const model = readDtaModel(readFileSync(dtaFile));
      expect(model.variables.map((v) => v.name)).toEqual(["id", "score", "grp", "name"]);
      expect(model.rows[0]).toEqual([1, 3.5, 1, "Alice"]);
      expect(model.rows[1]).toEqual([2, 9.25, 2, "Bob"]);
      // score row 3 is missing (-99 was a user-missing in SPSS, becomes sysmiss in Stata)
      expect(model.rows[2][0]).toBe(3);
      expect(model.rows[2][3]).toBe("Cörnelius");

      // value labels carried over
      const grpLabelsName = model.variables[2].valLabelsName;
      expect(grpLabelsName).not.toBeNull();
      const labels = model.valueLabels.get(grpLabelsName!);
      expect(labels?.find((l) => l.value === 1)?.label).toBe("Male");
      expect(labels?.find((l) => l.value === 2)?.label).toBe("Female");
    });
  });
});
