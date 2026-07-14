//
// txt/spss-commands.ts — parse SPSS command syntax (DATA LIST / VALUE LABELS /
// VARIABLE LABELS) into a schema. Focused port of
// readstat_spss_commands_read.rl covering the schema-defining commands.
//

import { ReadStatError, ReadStatException } from "../errors.js";
import { ReadStatType } from "../types.js";
import { ReadStatParser } from "../parser.js";
import { Schema, makeSchema, schemaFindOrCreateEntry, submitColumns, submitValueLabel, LabelType } from "./schema.js";

interface Tok {
  p: number;
  s: string;
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}
function isIdentStart(c: string): boolean {
  return /[A-Za-z]/.test(c);
}
function isIdentChar(c: string): boolean {
  return /[_A-Za-z0-9]/.test(c);
}

function skipWs(t: Tok): void {
  while (t.p < t.s.length && isSpace(t.s[t.p])) t.p++;
}
function peek(t: Tok): string {
  return t.s[t.p] ?? "";
}
function readIdent(t: Tok): string {
  let out = "";
  while (t.p < t.s.length && isIdentChar(t.s[t.p])) out += t.s[t.p++];
  return out;
}
function readInt(t: Tok): number {
  let n = 0;
  let any = false;
  while (t.p < t.s.length && t.s[t.p] >= "0" && t.s[t.p] <= "9") {
    n = 10 * n + (t.s.charCodeAt(t.p) - 0x30);
    t.p++;
    any = true;
  }
  if (!any) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  return n;
}
function readQuoted(t: Tok): string {
  const q = t.s[t.p];
  if (q !== "'" && q !== '"') throw new ReadStatException(ReadStatError.ERROR_PARSE);
  t.p++;
  let out = "";
  while (t.p < t.s.length && t.s[t.p] !== q) out += t.s[t.p++];
  if (t.s[t.p] !== q) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  t.p++;
  return out;
}

/** True if an SPSS command terminator '.' is at position (followed by ws/EOF). */
function isTerminator(t: Tok): boolean {
  if (t.s[t.p] !== ".") return false;
  const next = t.s[t.p + 1];
  return next === undefined || isSpace(next);
}

function skipToTerminator(t: Tok): void {
  while (t.p < t.s.length) {
    const c = t.s[t.p];
    if (c === "'" || c === '"') {
      readQuoted(t);
      continue;
    }
    if (isTerminator(t)) {
      t.p++;
      return;
    }
    t.p++;
  }
}

function parseDataList(t: Tok, schema: Schema): void {
  // skip args up to first "/" or terminator
  while (t.p < t.s.length && peek(t) !== "/" && !isTerminator(t)) {
    if (peek(t) === "'" || peek(t) === '"') readQuoted(t);
    else t.p++;
  }
  let varRow = 0;
  while (peek(t) === "/") {
    t.p++;
    skipWs(t);
    // optional record number
    if (peek(t) >= "0" && peek(t) <= "9") {
      varRow = readInt(t) - 1;
      skipWs(t);
    }
    // variable specs until next "/" or terminator
    while (t.p < t.s.length && peek(t) !== "/" && !isTerminator(t)) {
      skipWs(t);
      if (peek(t) === "/" || isTerminator(t)) break;
      if (!isIdentStart(peek(t))) break;
      const name = readIdent(t);
      skipWs(t);
      const col = readInt(t) - 1;
      let len = 1;
      skipWs(t);
      if (peek(t) === "-") {
        t.p++;
        skipWs(t);
        len = readInt(t) - col;
      }
      let type = ReadStatType.DOUBLE;
      skipWs(t);
      if (peek(t) === "(") {
        t.p++;
        skipWs(t);
        const c = peek(t);
        if (c === "A" || c === "a") {
          type = ReadStatType.STRING;
          t.p++;
          if (peek(t) >= "0" && peek(t) <= "9") readInt(t);
        } else if (c >= "0" && c <= "9") {
          readInt(t);
        }
        skipWs(t);
        if (peek(t) === ")") t.p++;
      }
      const entry = schemaFindOrCreateEntry(schema, name);
      entry.variable.type = type;
      entry.variable.storageWidth = len;
      entry.row = varRow;
      entry.col = col;
      entry.len = len;
    }
  }
  skipToTerminator(t);
}

function parseVariableLabels(t: Tok, schema: Schema): void {
  for (;;) {
    skipWs(t);
    if (isTerminator(t)) {
      t.p++;
      return;
    }
    if (peek(t) === "/") {
      t.p++;
      continue;
    }
    if (!isIdentStart(peek(t))) {
      skipToTerminator(t);
      return;
    }
    const name = readIdent(t);
    skipWs(t);
    if (peek(t) !== "'" && peek(t) !== '"') {
      skipToTerminator(t);
      return;
    }
    const label = readQuoted(t);
    const entry = schemaFindOrCreateEntry(schema, name);
    entry.variable.label = label;
  }
}

function parseValueLabels(t: Tok, parser: ReadStatParser, schema: Schema, labelsetCounter: { n: number }, userCtx: unknown): void {
  skipWs(t);
  if (peek(t) === "/") t.p++;
  for (;;) {
    skipWs(t);
    if (isTerminator(t)) {
      t.p++;
      return;
    }
    // variable list
    const vars: string[] = [];
    while (isIdentStart(peek(t))) {
      vars.push(readIdent(t));
      skipWs(t);
    }
    if (vars.length === 0) {
      skipToTerminator(t);
      return;
    }
    const labelsetName = "labels" + labelsetCounter.n;
    // value/label pairs until "/" or terminator
    for (;;) {
      skipWs(t);
      if (peek(t) === "/" || isTerminator(t)) break;
      // parse a value
      let labelType = LabelType.DOUBLE;
      let doubleValue = NaN;
      let firstInteger = 0;
      let lastInteger = 0;
      let stringValue = "";
      const c = peek(t);
      if (c === "'" || c === '"') {
        stringValue = readQuoted(t);
        labelType = LabelType.STRING;
      } else if (c === "-" || (c >= "0" && c <= "9")) {
        let neg = false;
        if (c === "-") {
          neg = true;
          t.p++;
        }
        const v = readInt(t);
        skipWs(t);
        if (peek(t) === "-" && !neg) {
          t.p++;
          skipWs(t);
          firstInteger = v;
          lastInteger = readInt(t);
          labelType = LabelType.RANGE;
        } else {
          doubleValue = neg ? -v : v;
          labelType = LabelType.DOUBLE;
        }
      } else {
        break;
      }
      skipWs(t);
      if (peek(t) !== "'" && peek(t) !== '"') break;
      const label = readQuoted(t);
      const e = submitValueLabel(parser, labelsetName, labelType, firstInteger, lastInteger, doubleValue, stringValue, label, userCtx);
      if (e !== ReadStatError.OK) throw new ReadStatException(e);
    }
    for (const v of vars) {
      const entry = schemaFindOrCreateEntry(schema, v);
      entry.labelset = labelsetName;
    }
    labelsetCounter.n++;
    skipWs(t);
    if (peek(t) === "/") t.p++;
  }
}

export function parseSpssCommands(parser: ReadStatParser, bytes: Uint8Array, userCtx: unknown): Schema {
  const text = new TextDecoder("latin1").decode(bytes);
  const t: Tok = { p: 0, s: text };
  const schema = makeSchema();
  schema.rowsPerObservation = 1;
  const labelsetCounter = { n: 0 };

  while (t.p < t.s.length) {
    skipWs(t);
    if (t.p >= t.s.length) break;
    if (peek(t) === "*") {
      // comment to terminator
      skipToTerminator(t);
      continue;
    }
    if (!isIdentStart(peek(t))) {
      t.p++;
      continue;
    }
    const save = t.p;
    const word = readIdent(t).toUpperCase();
    skipWs(t);
    if (word === "DATA") {
      const w2 = readIdent(t).toUpperCase();
      if (w2 === "LIST") {
        parseDataList(t, schema);
        continue;
      }
      t.p = save;
      skipToTerminator(t);
    } else if (word === "VARIABLE") {
      const w2 = readIdent(t).toUpperCase();
      if (w2 === "LABELS" || w2 === "LABEL") {
        parseVariableLabels(t, schema);
        continue;
      }
      t.p = save;
      skipToTerminator(t);
    } else if (word === "VALUE") {
      const w2 = readIdent(t).toUpperCase();
      if (w2 === "LABELS" || w2 === "LABEL") {
        parseValueLabels(t, parser, schema, labelsetCounter, userCtx);
        continue;
      }
      t.p = save;
      skipToTerminator(t);
    } else {
      t.p = save;
      skipToTerminator(t);
    }
  }

  const err = submitColumns(parser, schema, userCtx);
  if (err !== ReadStatError.OK) throw new ReadStatException(err);
  return schema;
}
