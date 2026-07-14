//
// roundtrip.e2e.test.ts — STRUCTURAL fidelity through the reference library.
//
// The CLI's CSV/metadata dump cannot show every structure (variable labels,
// value labels, user-defined missing ranges). To validate those end-to-end we
// go three ways: TS writes → the C library transcodes to another format → TS
// reads it back. Anything that survives the C round-trip was both written in a
// form C understood and read back correctly by the TS port.
//
import { describe, it, expect, beforeAll } from "vitest";
import {
  writeSav, readData, readSav, ReadStatType as T,
  type Dataset, type ReadableFormat,
} from "../../src/index.js";
import {
  requireReference, withTmpDir, refConvert, writeFileSync, readFileSync, join,
} from "../helpers/reference.js";

beforeAll(() => { requireReference(); });

function makeRichSav(): Uint8Array {
  return writeSav({
    fileLabel: "Rich dataset",
    valueLabelSets: {
      SEX: [{ value: 1, label: "Male" }, { value: 2, label: "Female" }],
    },
    variables: [
      { name: "ID", type: T.INT32, label: "Identifier" },
      { name: "SCORE", type: T.DOUBLE, label: "Test score", missingRanges: [[97, 99]] },
      { name: "SEX", type: T.INT32, label: "Sex", valueLabels: "SEX" },
    ],
    rows: [
      [1, 3.5, 1],
      [2, 88, 2],
      [3, 98, 1], // 98 is within the user-missing range 97..99
    ],
  });
}

function checkStructure(ds: Dataset): void {
  // variable labels
  expect(ds.variables[0].label).toBe("Identifier");
  expect(ds.variables[1].label).toBe("Test score");
  // value labels on SEX
  const sex = ds.variables.find((v) => v.name === "SEX")!;
  const map = new Map((sex.valueLabels ?? []).map((l) => [Number(l.value), l.label]));
  expect(map.get(1)).toBe("Male");
  expect(map.get(2)).toBe("Female");
}

describe("e2e: labels & missing ranges survive a TS→C→TS round-trip", () => {
  const targets: { name: string; ext: string; fmt: ReadableFormat }[] = [
    { name: "via sav", ext: "sav", fmt: "sav" },
    { name: "via zsav", ext: "zsav", fmt: "zsav" },
    { name: "via dta", ext: "dta", fmt: "dta" },
    { name: "via por", ext: "por", fmt: "por" },
  ];

  for (const t of targets) {
    it(`labels + value labels round-trip ${t.name}`, () => {
      withTmpDir((dir) => {
        const savPath = join(dir, "rich.sav");
        writeFileSync(savPath, makeRichSav());
        const outPath = join(dir, `out.${t.ext}`);
        refConvert(savPath, outPath);
        const ds = readData(t.fmt, readFileSync(outPath));
        checkStructure(ds);
      });
    });
  }

  it("user-defined missing range survives TS→C(sav)→TS", () => {
    withTmpDir((dir) => {
      const savPath = join(dir, "rich.sav");
      writeFileSync(savPath, makeRichSav());
      // round-trip through the C library to a fresh sav
      const outPath = join(dir, "rich2.sav");
      refConvert(savPath, outPath);
      const ds = readSav(readFileSync(outPath));
      const score = ds.variables.find((v) => v.name === "SCORE")!;
      expect(score.missingRanges.length).toBeGreaterThan(0);
      expect(Number(score.missingRanges[0].lo)).toBeCloseTo(97, 6);
      expect(Number(score.missingRanges[0].hi)).toBeCloseTo(99, 6);
    });
  });
});
