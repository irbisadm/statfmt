#!/usr/bin/env node
//
// next-version.mjs — preview the version semantic-release would publish.
//
// Computes the next version from Conventional Commits since the last version
// tag, using the same bump rules as the default (angular) preset:
//   BREAKING CHANGE / `!`  -> major
//   feat                   -> minor
//   fix | perf             -> patch
// Self-contained (git + Node only): no auth, no branch/PR detection, no plugins,
// so it works reliably on pull_request events where semantic-release --dry-run
// refuses to run.
//
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

let lastTag = "";
try {
  lastTag = sh('git describe --tags --match "v[0-9]*.[0-9]*.[0-9]*" --abbrev=0');
} catch {
  lastTag = ""; // no tags yet -> first release
}

const base = lastTag ? lastTag.replace(/^v/, "") : "0.0.0";
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const commits = sh(`git log ${range} --format=%B%x00`)
  .split("\0")
  .map((s) => s.trim())
  .filter(Boolean);

let level = 0; // 0 none, 1 patch, 2 minor, 3 major
for (const commit of commits) {
  const header = commit.split("\n")[0];
  const m = header.match(/^(\w+)(?:\(([^)]*)\))?(!)?:/);
  if (!m) continue;
  const type = m[1];
  const breaking = Boolean(m[3]) || /(^|\n)BREAKING[ -]CHANGE:/.test(commit);
  if (breaking) level = Math.max(level, 3);
  else if (type === "feat") level = Math.max(level, 2);
  else if (type === "fix" || type === "perf") level = Math.max(level, 1);
}

const [maj, min, pat] = base.split(".").map(Number);
let next = null;
if (level === 3) next = `${maj + 1}.0.0`;
else if (level === 2) next = `${maj}.${min + 1}.0`;
else if (level === 1) next = `${maj}.${min}.${pat + 1}`;

const line = next
  ? `### 📦 This PR would release \`v${next}\` (from \`${lastTag || "v0.0.0"}\`)`
  : "### 📦 No release: these commits don't trigger a version bump";

console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
}
