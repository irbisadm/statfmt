//
// helpers.ts — shared assertions for the end-to-end suite that validates the
// TypeScript port against the reference C `readstat` CLI.
//
import { expect } from "vitest";
import { refToCsv, parseCsv, refMetadata } from "../helpers/reference.js";

export type Cell = number | string | null;

/** Assert that the reference CLI reads `path` into exactly `header` + `rows`. */
export function assertCsvMatches(path: string, header: string[], rows: Cell[][]): void {
  const { header: h, rows: r } = parseCsv(refToCsv(path));
  expect(h).toEqual(header);
  expect(r.length).toBe(rows.length);
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i].length; j++) {
      const exp = rows[i][j];
      const got = r[i][j];
      if (exp === null) expect(got, `row ${i} col ${j} should be blank`).toBe("");
      else if (typeof exp === "number") expect(Number(got), `row ${i} col ${j}`).toBeCloseTo(exp, 4);
      else expect(got, `row ${i} col ${j}`).toBe(exp);
    }
  }
}

/** Extract a "Key: value" field from the reference metadata dump. */
export function metaField(path: string, key: string): string | null {
  const meta = refMetadata(path);
  const line = meta.split("\n").find((l) => l.startsWith(key + ":"));
  return line ? line.slice(key.length + 1).trim() : null;
}
