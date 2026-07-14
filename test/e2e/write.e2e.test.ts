//
// write.e2e.test.ts — GENERATION path.
//
// For every writable format, the TypeScript writer produces a file and the real
// ReadStat C CLI reads it back. We assert the CLI recovers the exact variable
// names, row values and column count (plus the file label where the format
// carries one). This proves each generated file is valid per the canonical
// implementation.
//
import { describe, it, expect, beforeAll } from "vitest";
import {
  writeSav, writeZsav, writeDta, writePor, writeXport, writeSas7bdat,
  ReadStatType as T,
} from "../../src/index.js";
import { requireReference, withTmpDir, writeFileSync, join } from "../helpers/reference.js";
import { assertCsvMatches, metaField, type Cell } from "./helpers.js";

beforeAll(() => { requireReference(); });

interface WriteCase {
  name: string;
  ext: string;
  bytes: () => Uint8Array;
  header: string[];
  rows: Cell[][];
  label?: string; // asserted against metadata "Table label"
  columns: number;
}

// value-label set reused by the label-carrying formats
const SEX = { SEX: [{ value: 1, label: "Male" }, { value: 2, label: "Female" }] };

const cases: WriteCase[] = [
  {
    name: "sav",
    ext: "sav",
    header: ["id", "score", "sex", "name"],
    rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bøb"], [3, null, 1, "Carol"]],
    label: "SAV demo",
    columns: 4,
    bytes: () =>
      writeSav({
        fileLabel: "SAV demo",
        valueLabelSets: SEX,
        variables: [
          { name: "id", type: T.INT32, label: "Identifier" },
          { name: "score", type: T.DOUBLE, label: "Test score" },
          { name: "sex", type: T.INT32, valueLabels: "SEX" },
          { name: "name", type: T.STRING, storageWidth: 12 },
        ],
        rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bøb"], [3, null, 1, "Carol"]],
      }),
  },
  {
    name: "zsav",
    ext: "zsav",
    header: ["id", "score", "sex", "name"],
    rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bøb"], [3, null, 1, "Carol"]],
    label: "ZSAV demo",
    columns: 4,
    bytes: () =>
      writeZsav({
        fileLabel: "ZSAV demo",
        valueLabelSets: SEX,
        variables: [
          { name: "id", type: T.INT32 },
          { name: "score", type: T.DOUBLE },
          { name: "sex", type: T.INT32, valueLabels: "SEX" },
          { name: "name", type: T.STRING, storageWidth: 12 },
        ],
        rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bøb"], [3, null, 1, "Carol"]],
      }),
  },
  {
    name: "dta v118 (UTF-8)",
    ext: "dta",
    header: ["id", "score", "sex", "name"],
    rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bøb"], [3, null, 1, "Carol"]],
    label: "DTA demo",
    columns: 4,
    bytes: () =>
      writeDta({
        fileLabel: "DTA demo",
        version: 118,
        valueLabelSets: SEX,
        variables: [
          { name: "id", type: T.INT32, label: "Identifier" },
          { name: "score", type: T.DOUBLE },
          { name: "sex", type: T.INT32, valueLabels: "SEX" },
          { name: "name", type: T.STRING, storageWidth: 12 },
        ],
        rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bøb"], [3, null, 1, "Carol"]],
      }),
  },
  {
    name: "dta v117 (ASCII)",
    ext: "dta",
    header: ["id", "score", "name"],
    rows: [[1, 3.5, "Alice"], [2, 9.25, "Bob"]],
    label: "DTA117",
    columns: 3,
    bytes: () =>
      writeDta({
        fileLabel: "DTA117",
        version: 117,
        variables: [
          { name: "id", type: T.INT32 },
          { name: "score", type: T.DOUBLE },
          { name: "name", type: T.STRING, storageWidth: 10 },
        ],
        rows: [[1, 3.5, "Alice"], [2, 9.25, "Bob"]],
      }),
  },
  {
    name: "por",
    ext: "por",
    header: ["ID", "SCORE", "GRP", "NAME"],
    rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bob"], [3, null, 1, "Carol"]],
    columns: 4,
    bytes: () =>
      writePor({
        valueLabelSets: SEX,
        variables: [
          { name: "ID", type: T.INT32 },
          { name: "SCORE", type: T.DOUBLE },
          { name: "GRP", type: T.INT32, valueLabels: "SEX" },
          { name: "NAME", type: T.STRING, storageWidth: 12 },
        ],
        rows: [[1, 3.5, 1, "Alice"], [2, 9.25, 2, "Bob"], [3, null, 1, "Carol"]],
      }),
  },
  {
    name: "xport v5",
    ext: "xpt",
    header: ["ID", "SCORE", "NAME"],
    rows: [[1, 3.5, "Alice"], [2, 9.25, "Bob"], [3, null, "Carol"]],
    columns: 3,
    bytes: () =>
      writeXport({
        variables: [
          { name: "ID", type: T.DOUBLE },
          { name: "SCORE", type: T.DOUBLE, format: "8.2" },
          { name: "NAME", type: T.STRING, storageWidth: 8 },
        ],
        rows: [[1, 3.5, "Alice"], [2, 9.25, "Bob"], [3, null, "Carol"]],
      }),
  },
  {
    name: "sas7bdat",
    ext: "sas7bdat",
    header: ["id", "score", "name"],
    rows: [[1, 3.5, "Alice"], [2, 9.25, "Bob"], [3, null, "Carol"]],
    columns: 3,
    bytes: () =>
      writeSas7bdat({
        variables: [
          { name: "id", type: T.DOUBLE },
          { name: "score", type: T.DOUBLE, format: "BEST12" },
          { name: "name", type: T.STRING, storageWidth: 12, label: "Full name" },
        ],
        rows: [[1, 3.5, "Alice"], [2, 9.25, "Bob"], [3, null, "Carol"]],
      }),
  },
];

describe("e2e: generation is read back correctly by reference ReadStat", () => {
  for (const c of cases) {
    it(`writes ${c.name} → C reads exact values`, () => {
      withTmpDir((dir) => {
        const path = join(dir, `data.${c.ext}`);
        writeFileSync(path, c.bytes());
        assertCsvMatches(path, c.header, c.rows);
        expect(metaField(path, "Columns")).toBe(String(c.columns));
        if (c.label !== undefined) expect(metaField(path, "Table label")).toBe(c.label);
      });
    });
  }
});
