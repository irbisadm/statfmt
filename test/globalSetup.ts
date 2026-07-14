//
// globalSetup.ts — ensure the reference C ReadStat CLI is available before the
// end-to-end suite runs. If it is missing we attempt to build it once via
// scripts/build-reference.sh. Set READSTAT_NO_AUTOBUILD=1 to skip the build
// (the e2e tests then fail fast with actionable guidance).
//
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.READSTAT_BIN ?? join(REPO_ROOT, ".reference", "ReadStat", "readstat");

export default function setup(): void {
  if (existsSync(BIN)) return;
  if (process.env.READSTAT_NO_AUTOBUILD) {
    console.warn("[e2e] reference CLI missing and autobuild disabled; e2e tests will fail.");
    return;
  }
  console.log("[e2e] building reference ReadStat CLI (one-time) ...");
  try {
    execFileSync("bash", [join(REPO_ROOT, "scripts", "build-reference.sh")], {
      stdio: "inherit",
      timeout: 5 * 60 * 1000,
    });
  } catch {
    console.warn("[e2e] reference build failed; e2e tests will report a helpful error.");
  }
}
