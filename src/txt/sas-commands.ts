//
// txt/sas-commands.ts — parse SAS command syntax (INPUT / INFILE / LABEL /
// FORMAT / PROC FORMAT VALUE) into a schema. Focused port of
// readstat_sas_commands_read.rl covering the schema-defining commands.
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
  return /[$_A-Za-z]/.test(c);
}
function skipWs(t: Tok): void {
  while (t.p < t.s.length && isSpace(t.s[t.p])) t.p++;
}
function peek(t: Tok): string {
  return t.s[t.p] ?? "";
}
function readIdent(t: Tok): string {
  // identifier = [$_A-Za-z][_A-Za-z0-9]*  (dots not part of a bare var name here)
  let out = "";
  if (!/[$_A-Za-z]/.test(peek(t))) return out;
  out += t.s[t.p++];
  while (t.p < t.s.length && /[_A-Za-z0-9]/.test(t.s[t.p])) out += t.s[t.p++];
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
  while (t.p < t.s.length) {
    if (t.s[t.p] === q) {
      if (t.s[t.p + 1] === q) {
        out += q;
        t.p += 2;
        continue;
      }
      break;
    }
    out += t.s[t.p++];
  }
  if (t.s[t.p] !== q) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  t.p++;
  return out;
}
function skipToSemicolon(t: Tok): void {
  while (t.p < t.s.length) {
    const c = t.s[t.p];
    if (c === "'" || c === '"') {
      readQuoted(t);
      continue;
    }
    if (c === ";") {
      t.p++;
      return;
    }
    t.p++;
  }
}

function parseInput(t: Tok, schema: Schema): void {
  let varRow = 0;
  for (;;) {
    skipWs(t);
    if (peek(t) === ";") {
      t.p++;
      return;
    }
    if (t.p >= t.s.length) return;
    const c = peek(t);
    if (c === "#") {
      t.p++;
      varRow = readInt(t) - 1;
      continue;
    }
    if (c === "@") {
      t.p++;
      const col = readInt(t) - 1;
      skipWs(t);
      const name = readIdent(t).toLowerCase();
      skipWs(t);
      // (var_len | input_format_spec) "."
      let type = ReadStatType.DOUBLE;
      let len = 0;
      if (peek(t) === "$") {
        t.p++;
        skipWs(t);
        if (/[A-Za-z]/.test(peek(t))) {
          // $CHARn or $format
          const fmt = readIdent(t); // e.g. CHAR
          if (peek(t) >= "0" && peek(t) <= "9") len = readInt(t);
          type = ReadStatType.STRING;
          void fmt;
        } else {
          len = readInt(t);
          type = ReadStatType.STRING;
        }
      } else if (peek(t) >= "0" && peek(t) <= "9") {
        len = readInt(t);
        type = ReadStatType.DOUBLE;
      } else {
        readIdent(t); // format name
        type = ReadStatType.DOUBLE;
      }
      if (peek(t) === ".") t.p++;
      if (peek(t) >= "0" && peek(t) <= "9") readInt(t);
      const entry = schemaFindOrCreateEntry(schema, name);
      entry.variable.type = type;
      entry.variable.storageWidth = len;
      entry.row = varRow;
      entry.col = col;
      entry.len = len;
      continue;
    }
    if (isIdentStart(c)) {
      const name = readIdent(t).toLowerCase();
      skipWs(t);
      if (peek(t) === "$") {
        // input_txt_spec: var $ int - int
        t.p++;
        skipWs(t);
        const col = readInt(t) - 1;
        skipWs(t);
        if (peek(t) === "-") {
          t.p++;
          skipWs(t);
          const len = readInt(t) - col;
          const entry = schemaFindOrCreateEntry(schema, name);
          entry.variable.type = ReadStatType.STRING;
          entry.variable.storageWidth = len;
          entry.row = varRow;
          entry.col = col;
          entry.len = len;
        }
        continue;
      }
      if (peek(t) >= "0" && peek(t) <= "9") {
        // input_int_spec: var int - int
        const col = readInt(t) - 1;
        skipWs(t);
        if (peek(t) === "-") {
          t.p++;
          skipWs(t);
          const len = readInt(t) - col;
          const entry = schemaFindOrCreateEntry(schema, name);
          entry.variable.type = ReadStatType.DOUBLE;
          entry.row = varRow;
          entry.col = col;
          entry.len = len;
        }
        continue;
      }
      // bare var — create entry with name only
      schemaFindOrCreateEntry(schema, name);
      continue;
    }
    // unrecognized token; bail out to statement end
    skipToSemicolon(t);
    return;
  }
}

function parseInfile(t: Tok, schema: Schema): void {
  for (;;) {
    skipWs(t);
    if (peek(t) === ";") {
      t.p++;
      return;
    }
    if (t.p >= t.s.length) return;
    if (peek(t) === "'" || peek(t) === '"') {
      readQuoted(t);
      continue;
    }
    if (isIdentStart(peek(t))) {
      const arg = readIdent(t).toLowerCase();
      skipWs(t);
      if (peek(t) === "=") {
        t.p++;
        skipWs(t);
        let val = "";
        let intVal = 0;
        if (peek(t) === "'" || peek(t) === '"') val = readQuoted(t);
        else if (peek(t) >= "0" && peek(t) <= "9") intVal = readInt(t);
        else val = readIdent(t);
        if (arg === "firstobs") schema.firstLine = intVal;
        if (arg === "dlm") schema.fieldDelimiter = val ? val[0] : String.fromCharCode(intVal);
      }
      continue;
    }
    t.p++;
  }
}

function parseLabel(t: Tok, schema: Schema): void {
  for (;;) {
    skipWs(t);
    if (peek(t) === ";") {
      t.p++;
      return;
    }
    if (!isIdentStart(peek(t))) {
      skipToSemicolon(t);
      return;
    }
    const name = readIdent(t).toLowerCase();
    skipWs(t);
    if (peek(t) !== "=") {
      skipToSemicolon(t);
      return;
    }
    t.p++;
    skipWs(t);
    if (peek(t) !== "'" && peek(t) !== '"') {
      skipToSemicolon(t);
      return;
    }
    const label = readQuoted(t);
    const entry = schemaFindOrCreateEntry(schema, name);
    entry.variable.label = label;
  }
}

function parseFormat(t: Tok, schema: Schema): void {
  for (;;) {
    skipWs(t);
    if (peek(t) === ";") {
      t.p++;
      return;
    }
    if (!isIdentStart(peek(t))) {
      skipToSemicolon(t);
      return;
    }
    const name = readIdent(t).toLowerCase();
    skipWs(t);
    // format spec: labelset "." | int "." int? | date
    if (peek(t) >= "0" && peek(t) <= "9") {
      readInt(t);
      if (peek(t) === ".") t.p++;
      if (peek(t) >= "0" && peek(t) <= "9") readInt(t);
    } else if (isIdentStart(peek(t))) {
      const labelset = readIdent(t);
      if (peek(t) === ".") t.p++;
      const entry = schemaFindOrCreateEntry(schema, name);
      entry.labelset = labelset;
    } else {
      skipToSemicolon(t);
      return;
    }
  }
}

function parseValueCmd(t: Tok, parser: ReadStatParser, schema: Schema, userCtx: unknown): void {
  skipWs(t);
  const labelset = readIdent(t);
  void schema;
  skipWs(t);
  // optional "( args )"
  if (peek(t) === "(") {
    let depth = 0;
    do {
      const c = t.s[t.p++];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    } while (t.p < t.s.length && depth > 0);
    skipWs(t);
  }
  for (;;) {
    skipWs(t);
    if (peek(t) === ";") {
      t.p++;
      return;
    }
    if (t.p >= t.s.length) return;
    let labelType = LabelType.DOUBLE;
    let doubleValue = NaN;
    let firstInteger = 0;
    let lastInteger = 0;
    let stringValue = "";
    const c = peek(t);
    if (c === ".") {
      t.p++;
      if (/[A-Z]/.test(peek(t))) t.p++;
      labelType = LabelType.NAN;
    } else if (c === "'" || c === '"') {
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
    } else if (/[A-Za-z]/.test(c)) {
      const id = readIdent(t);
      if (id.toLowerCase() === "other") {
        labelType = LabelType.OTHER;
      } else {
        stringValue = id;
        labelType = LabelType.STRING;
      }
    } else {
      skipToSemicolon(t);
      return;
    }
    skipWs(t);
    if (peek(t) !== "=") {
      skipToSemicolon(t);
      return;
    }
    t.p++;
    skipWs(t);
    if (peek(t) !== "'" && peek(t) !== '"') {
      skipToSemicolon(t);
      return;
    }
    const label = readQuoted(t);
    const e = submitValueLabel(parser, labelset, labelType, firstInteger, lastInteger, doubleValue, stringValue, label, userCtx);
    if (e !== ReadStatError.OK) throw new ReadStatException(e);
  }
}

export function parseSasCommands(parser: ReadStatParser, bytes: Uint8Array, userCtx: unknown): Schema {
  const text = new TextDecoder("latin1").decode(bytes);
  const t: Tok = { p: 0, s: text };
  const schema = makeSchema();
  schema.rowsPerObservation = 1;

  while (t.p < t.s.length) {
    skipWs(t);
    if (t.p >= t.s.length) break;
    if (t.s.startsWith("/*", t.p)) {
      t.p += 2;
      while (t.p < t.s.length && !t.s.startsWith("*/", t.p)) t.p++;
      if (t.s.startsWith("*/", t.p)) t.p += 2;
      continue;
    }
    if (peek(t) === "*") {
      skipToSemicolon(t);
      continue;
    }
    if (peek(t) === ";") {
      t.p++;
      continue;
    }
    if (!isIdentStart(peek(t))) {
      t.p++;
      continue;
    }
    const save = t.p;
    const word = readIdent(t).toUpperCase();
    if (word === "INPUT") {
      skipWs(t);
      parseInput(t, schema);
    } else if (word === "INFILE") {
      parseInfile(t, schema);
    } else if (word === "LABEL") {
      parseLabel(t, schema);
    } else if (word === "FORMAT") {
      parseFormat(t, schema);
    } else if (word === "VALUE") {
      parseValueCmd(t, parser, schema, userCtx);
    } else {
      t.p = save;
      skipToSemicolon(t);
    }
  }

  const err = submitColumns(parser, schema, userCtx);
  if (err !== ReadStatError.OK) throw new ReadStatException(err);
  return schema;
}
