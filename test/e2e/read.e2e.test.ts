//
// read.e2e.test.ts — READING path.
//
// The real ReadStat C CLI generates a genuine file in each format (by
// transcoding a base SPSS file the TS writer produced and the C library already
// validated), and the TypeScript reader parses it. We assert the TS reader
// recovers the exact variable names, values and — where the format carries them
// in a standalone file — value labels.
//
import { describe, it, expect, beforeAll } from "vitest";
import {
  writeSav, readSav, readData, readDta, readPor, readXport, readSas7bdat,
  ReadStatType as T,
  type Dataset,
} from "../../src/index.js";
import {
  requireReference, withTmpDir, refConvert, writeFileSync, readFileSync, join,
} from "../helpers/reference.js";

type Cell = number | string | null;

beforeAll(() => { requireReference(); });

// Base dataset: UPPERCASE, short (<=8), ASCII names so every C writer accepts it.
const EXPECT_NAMES = ["ID", "SCORE", "SEX", "NAME"];
const EXPECT_ROWS: Cell[][] = [
  [1, 3.5, 1, "Alice"],
  [2, 9.25, 2, "Bob"],
  [3, null, 1, "Carol"],
];

function makeBaseSav(): Uint8Array {
  return writeSav({
    fileLabel: "BASE",
    valueLabelSets: { SEX: [{ value: 1, label: "Male" }, { value: 2, label: "Female" }] },
    variables: [
      { name: "ID", type: T.INT32 },
      { name: "SCORE", type: T.DOUBLE },
      { name: "SEX", type: T.INT32, valueLabels: "SEX" },
      { name: "NAME", type: T.STRING, storageWidth: 8 },
    ],
    rows: EXPECT_ROWS,
  });
}

function assertRows(rows: Cell[][], expected: Cell[][]): void {
  expect(rows.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < expected[i].length; j++) {
      const e = expected[i][j];
      const g = rows[i][j];
      if (e === null) expect(g, `row ${i} col ${j}`).toBeNull();
      else if (typeof e === "number") expect(g as number, `row ${i} col ${j}`).toBeCloseTo(e, 6);
      else expect(g, `row ${i} col ${j}`).toBe(e);
    }
  }
}

function assertSexLabels(ds: Dataset): void {
  const sex = ds.variables.find((v) => v.name === "SEX");
  expect(sex, "SEX variable present").toBeTruthy();
  const labels = sex!.valueLabels ?? [];
  const map = new Map(labels.map((l) => [Number(l.value), l.label]));
  expect(map.get(1)).toBe("Male");
  expect(map.get(2)).toBe("Female");
}

interface ReadCase {
  name: string;
  ext: string;
  read: (bytes: Uint8Array) => Dataset;
  labels: boolean; // does a standalone file in this format carry value labels?
}

const cases: ReadCase[] = [
  { name: "sav", ext: "sav", read: (b) => readSav(b), labels: true },
  { name: "zsav", ext: "zsav", read: (b) => readData("zsav", b), labels: true },
  { name: "dta", ext: "dta", read: (b) => readDta(b), labels: true },
  { name: "por", ext: "por", read: (b) => readPor(b), labels: true },
  { name: "xport", ext: "xpt", read: (b) => readXport(b), labels: false },
  // .sas7bdat stores value labels in a companion .sas7bcat catalog, not the data file
  { name: "sas7bdat", ext: "sas7bdat", read: (b) => readSas7bdat(b), labels: false },
];

describe("e2e: reference-generated files are read correctly by the TS port", () => {
  for (const c of cases) {
    it(`C writes ${c.name} → TS reads exact values${c.labels ? " + value labels" : ""}`, () => {
      withTmpDir((dir) => {
        const savPath = join(dir, "base.sav");
        writeFileSync(savPath, makeBaseSav());

        // Always transcode through the C library so the file under test is
        // genuinely produced by reference ReadStat (sav → out.sav included).
        const filePath = join(dir, `out.${c.ext}`);
        refConvert(savPath, filePath);

        const ds = c.read(readFileSync(filePath));
        expect(ds.variables.map((v) => v.name)).toEqual(EXPECT_NAMES);
        assertRows(ds.rows, EXPECT_ROWS);
        if (c.labels) assertSexLabels(ds);
      });
    });
  }
});
