import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, ReadStatMeasure } from "../src/index.js";
import { readSavModel } from "./helpers/model.js";
import { buildSampleSav } from "./helpers/build-sav.js";
import { hasReference, refConvert, withTmpDir } from "./helpers/reference.js";

describe("SAV reader (round-trip)", () => {
  it("reads back a TS-written file", () => {
    const bytes = buildSampleSav();
    const model = readSavModel(bytes);

    expect(model.metadata?.varCount).toBe(4);
    expect(model.metadata?.rowCount).toBe(3);
    expect(model.metadata?.fileLabel).toBe("test file");

    expect(model.variables.map((v) => v.name)).toEqual(["id", "score", "grp", "name"]);
    expect(model.variables[1].label).toBe("Test score");
    expect(model.variables[1].type).toBe(ReadStatType.DOUBLE);
    expect(model.variables[3].type).toBe(ReadStatType.STRING);
    expect(model.variables[3].storageWidth).toBe(24); // ceil(20/8)*8
    expect(model.variables[0].measure).toBe(ReadStatMeasure.SCALE);
    expect(model.variables[2].measure).toBe(ReadStatMeasure.NOMINAL);

    // value labels
    expect(model.variables[2].valLabelsName).not.toBeNull();
    const labels = model.valueLabels.get(model.variables[2].valLabelsName!);
    expect(labels).toEqual([
      { value: 1, label: "Male" },
      { value: 2, label: "Female" },
    ]);

    // missing value definition
    expect(model.variables[1].missingRanges).toEqual([{ lo: -99, hi: -99 }]);

    // data
    expect(model.rows).toEqual([
      [1, 3.5, 1, "Alice"],
      [2, 9.25, 2, "Bob"],
      [3, null, 1, "Cörnelius"],
    ]);
  });

  it("reads a row-compressed file", () => {
    const bytes = buildSampleSav({ compress: 1 });
    const model = readSavModel(bytes);
    expect(model.metadata?.compression).toBe(1);
    expect(model.rows).toEqual([
      [1, 3.5, 1, "Alice"],
      [2, 9.25, 2, "Bob"],
      [3, null, 1, "Cörnelius"],
    ]);
  });
});

describe.runIf(hasReference())("SAV reader vs reference-produced file", () => {
  it("reads a file re-encoded by the C library", () => {
    const bytes = buildSampleSav();
    withTmpDir((dir) => {
      const inFile = join(dir, "in.sav");
      const outFile = join(dir, "out.sav");
      writeFileSync(inFile, bytes);
      refConvert(inFile, outFile); // C reads our file and writes a fresh one
      const model = readSavModel(readFileSync(outFile));
      expect(model.variables.map((v) => v.name)).toEqual(["id", "score", "grp", "name"]);
      expect(model.rows).toEqual([
        [1, 3.5, 1, "Alice"],
        [2, 9.25, 2, "Bob"],
        [3, null, 1, "Cörnelius"],
      ]);
    });
  });
});
