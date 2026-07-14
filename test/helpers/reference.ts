//
// reference.ts — bridge to the reference C `readstat` CLI for cross-validation.
//
// The C library is built under the scratchpad; these helpers shell out to it
// so tests can compare the TS port against the canonical implementation.
//

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.READSTAT_BIN,
  "/tmp/claude-1000/-home-irbisadm-IdeaProjects-spss/8226504e-c7f2-4249-ab93-bd6e73342c79/scratchpad/ReadStat/readstat",
].filter(Boolean) as string[];

export const REFERENCE_BIN = CANDIDATES.find((p) => existsSync(p)) ?? null;

export function hasReference(): boolean {
  return REFERENCE_BIN !== null;
}

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "readstat-ts-"));
}

/** Run the reference CLI, returning stdout as a Buffer. */
export function runReference(args: string[]): Buffer {
  if (!REFERENCE_BIN) throw new Error("reference readstat binary not available");
  return execFileSync(REFERENCE_BIN, args, { maxBuffer: 256 * 1024 * 1024 });
}

/** Dump a data file to CSV using the reference implementation. */
export function refToCsv(file: string): string {
  return runReference([file, "-"]).toString("utf-8");
}

/** Convert a data file from one format to another using the reference implementation. */
export function refConvert(inFile: string, outFile: string): void {
  runReference([inFile, outFile]);
}

/** Print a file's metadata (human-readable) using the reference implementation. */
export function refMetadata(file: string): string {
  return runReference([file]).toString("utf-8");
}

/** Parse the reference CSV dump into a header + row matrix of raw strings. */
export function parseCsv(csv: string): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else if (c === "\r") {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const header = records.shift() ?? [];
  // drop trailing empty record
  const rows = records.filter((r) => !(r.length === 1 && r[0] === ""));
  return { header, rows };
}

export function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = makeTmpDir();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export { writeFileSync, readFileSync, join };
