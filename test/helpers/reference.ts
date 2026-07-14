//
// reference.ts — bridge to the reference C `readstat` CLI for cross-validation.
//
// The C library is built under the scratchpad; these helpers shell out to it
// so tests can compare the TS port against the canonical implementation.
//

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Durable location produced by `npm run build:reference`. */
export const REFERENCE_BUILD_PATH = join(REPO_ROOT, ".reference", "ReadStat", "readstat");

const CANDIDATES = [
  process.env.READSTAT_BIN,
  REFERENCE_BUILD_PATH,
].filter(Boolean) as string[];

/** Resolved lazily so a build triggered by globalSetup is picked up. */
export function resolveReferenceBin(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export const REFERENCE_BIN = resolveReferenceBin();

export function hasReference(): boolean {
  return resolveReferenceBin() !== null;
}

/** Throw with actionable guidance if the reference CLI is not available. */
export function requireReference(): string {
  const bin = resolveReferenceBin();
  if (!bin) {
    throw new Error(
      "reference readstat binary not available — run `npm run build:reference` " +
        "(needs a C compiler, make, zlib and iconv) or set READSTAT_BIN to a built CLI.",
    );
  }
  return bin;
}

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "statfmt-"));
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
