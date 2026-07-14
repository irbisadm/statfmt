//
// txt/stata-dictionary.ts — parse a Stata dictionary (.dct) into a schema
// (port of readstat_stata_dictionary_read.rl)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import { ReadStatType, HandlerStatus } from "../types.js";
import { ReadStatParser } from "../parser.js";
import { Schema, SchemaEntry, makeSchema, makeSchemaEntry } from "./schema.js";

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

class Cursor {
  s: string;
  p = 0;
  constructor(s: string) {
    this.s = s;
  }
  eof(): boolean {
    return this.p >= this.s.length;
  }
  peek(): string {
    return this.s[this.p] ?? "";
  }
  starts(str: string): boolean {
    return this.s.startsWith(str, this.p);
  }
  skipSpaceTab(): void {
    while (this.p < this.s.length && (this.s[this.p] === " " || this.s[this.p] === "\t")) this.p++;
  }
  skipWhitespace(): void {
    while (this.p < this.s.length && /[ \t\r\n]/.test(this.s[this.p])) this.p++;
  }
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z]/.test(c);
}
function isIdentChar(c: string): boolean {
  return /[_.A-Za-z0-9]/.test(c);
}

function parseInteger(cur: Cursor): number {
  let n = 0;
  let any = false;
  while (cur.p < cur.s.length && cur.s[cur.p] >= "0" && cur.s[cur.p] <= "9") {
    n = 10 * n + (cur.s.charCodeAt(cur.p) - 0x30);
    cur.p++;
    any = true;
  }
  if (!any) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  return n;
}

/** Parse "_name( int )" returning the integer. */
function parseMarkerArg(cur: Cursor): number {
  if (cur.peek() !== "(") throw new ReadStatException(ReadStatError.ERROR_PARSE);
  cur.p++;
  cur.skipSpaceTab();
  const n = parseInteger(cur);
  cur.skipSpaceTab();
  if (cur.peek() !== ")") throw new ReadStatException(ReadStatError.ERROR_PARSE);
  cur.p++;
  return n;
}

function parseQuoted(cur: Cursor): string {
  if (cur.peek() !== '"') throw new ReadStatException(ReadStatError.ERROR_PARSE);
  cur.p++;
  let out = "";
  while (cur.p < cur.s.length && cur.s[cur.p] !== '"') {
    out += cur.s[cur.p++];
  }
  if (cur.peek() !== '"') throw new ReadStatException(ReadStatError.ERROR_PARSE);
  cur.p++;
  return out;
}

const TYPE_KEYWORDS: [string, ReadStatType][] = [
  ["byte", ReadStatType.INT8],
  ["int", ReadStatType.INT16],
  ["long", ReadStatType.INT32],
  ["float", ReadStatType.FLOAT],
  ["double", ReadStatType.DOUBLE],
];

interface State {
  currentRow: number;
  currentCol: number;
  totalEntryCount: number;
  partialEntryCount: number;
}

function parseComment(cur: Cursor): void {
  if (cur.starts("/*")) {
    cur.p += 2;
    while (cur.p < cur.s.length && !cur.starts("*/")) cur.p++;
    if (cur.starts("*/")) cur.p += 2;
  } else if (cur.peek() === "*") {
    while (cur.p < cur.s.length && cur.s[cur.p] !== "\n") cur.p++;
    if (cur.peek() === "\n") cur.p++;
  }
}

function parseMarker(cur: Cursor, schema: Schema, st: State): void {
  if (cur.starts("_lrecl")) {
    cur.p += 6;
    cur.skipSpaceTab();
    schema.colsPerObservation = parseMarkerArg(cur);
  } else if (cur.starts("_firstlineoffile")) {
    cur.p += 16;
    cur.skipSpaceTab();
    schema.firstLine = parseMarkerArg(cur) - 1;
  } else if (cur.starts("_lines")) {
    cur.p += 6;
    cur.skipSpaceTab();
    schema.rowsPerObservation = parseMarkerArg(cur);
  } else if (cur.starts("_line")) {
    cur.p += 5;
    cur.skipSpaceTab();
    st.currentRow = parseMarkerArg(cur) - 1;
  } else if (cur.starts("_column")) {
    cur.p += 7;
    cur.skipSpaceTab();
    st.currentCol = parseMarkerArg(cur) - 1;
  } else if (cur.starts("_newline")) {
    cur.p += 8;
    st.currentRow++;
    cur.skipSpaceTab();
    if (cur.peek() === "(") {
      st.currentRow += parseMarkerArg(cur) - 1;
    }
  } else if (cur.starts("_skip")) {
    cur.p += 5;
    cur.skipSpaceTab();
    st.currentCol += parseMarkerArg(cur) - 1;
  } else {
    throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }
}

function parseEntry(cur: Cursor, parser: ReadStatParser, schema: Schema, st: State, userCtx: unknown): void {
  const entry: SchemaEntry = makeSchemaEntry(st.totalEntryCount);

  // optional type
  const start = cur.p;
  let matchedType = false;
  for (const [kw, type] of TYPE_KEYWORDS) {
    if (cur.starts(kw) && !isIdentChar(cur.s[cur.p + kw.length] ?? "")) {
      cur.p += kw.length;
      entry.variable.type = type;
      matchedType = true;
      break;
    }
  }
  if (!matchedType && cur.starts("str")) {
    const after = cur.p + 3;
    if (cur.s[after] >= "0" && cur.s[after] <= "9") {
      cur.p += 3;
      const w = parseInteger(cur);
      entry.variable.type = ReadStatType.STRING;
      entry.variable.storageWidth = w;
      matchedType = true;
    }
  }
  if (matchedType) {
    // require whitespace after type
    if (!/[ \t]/.test(cur.peek())) {
      cur.p = start; // not actually a type; treat first token as varname
      entry.variable.type = ReadStatType.DOUBLE;
    } else {
      cur.skipSpaceTab();
    }
  }

  // varname (identifier)
  if (!isIdentStart(cur.peek())) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  let name = cur.s[cur.p++];
  while (cur.p < cur.s.length && isIdentChar(cur.s[cur.p])) name += cur.s[cur.p++];
  entry.variable.name = name;

  // optional format
  const save1 = cur.p;
  cur.skipSpaceTab();
  if (cur.peek() === "%") {
    cur.p++;
    entry.len = parseInteger(cur);
    const c = cur.peek();
    if (c === "s" || c === "S") {
      cur.p++;
    } else {
      if (c === "." || c === ",") {
        if (c === ",") entry.decimalSeparator = ",";
        cur.p++;
        parseInteger(cur);
      }
      const f = cur.peek();
      if (f === "f" || f === "g" || f === "e") cur.p++;
    }
  } else {
    cur.p = save1;
  }

  // optional label
  const save2 = cur.p;
  cur.skipSpaceTab();
  if (cur.peek() === '"') {
    entry.variable.label = parseQuoted(cur);
  } else {
    cur.p = save2;
  }

  // trailing spaces + newline
  cur.skipSpaceTab();
  if (cur.peek() === "\r") cur.p++;
  if (cur.peek() === "\n") cur.p++;

  // end_entry
  entry.row = st.currentRow;
  entry.col = st.currentCol;
  st.currentCol += entry.len;
  let cb = HandlerStatus.OK as number;
  if (parser.handlers.variable) {
    entry.variable.indexAfterSkipping = st.partialEntryCount;
    cb = hstatus(parser.handlers.variable(st.totalEntryCount, entry.variable, null, userCtx));
    if (cb === HandlerStatus.ABORT) throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
  }
  if (cb === HandlerStatus.SKIP_VARIABLE) entry.skip = 1;
  else st.partialEntryCount++;
  schema.entries.push(entry);
  st.totalEntryCount++;
}

export function parseStataDictionary(parser: ReadStatParser, schemaBytes: Uint8Array, userCtx: unknown): Schema {
  const text = new TextDecoder("latin1").decode(schemaBytes);
  const cur = new Cursor(text);
  const schema = makeSchema();
  schema.rowsPerObservation = 1;
  const st: State = { currentRow: 0, currentCol: 0, totalEntryCount: 0, partialEntryCount: 0 };

  // leading comments
  for (;;) {
    cur.skipWhitespace();
    if (cur.peek() === "*" || cur.starts("/*")) parseComment(cur);
    else break;
  }
  // optional "infile"
  cur.skipWhitespace();
  if (cur.starts("infile")) {
    cur.p += 6;
    cur.skipWhitespace();
  }
  if (!cur.starts("dictionary")) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  cur.p += 10;
  cur.skipWhitespace();
  if (cur.starts("using")) {
    cur.p += 5;
    cur.skipWhitespace();
    // filename (quoted or unquoted) — skip
    if (cur.peek() === '"') parseQuoted(cur);
    else while (cur.p < cur.s.length && /[A-Za-z0-9_/\\.\-]/.test(cur.s[cur.p])) cur.p++;
    cur.skipWhitespace();
  }
  if (cur.peek() !== "{") throw new ReadStatException(ReadStatError.ERROR_PARSE);
  cur.p++;

  // contents
  for (;;) {
    cur.skipWhitespace();
    const c = cur.peek();
    if (c === "}" || c === "") break;
    if (c === "*" || cur.starts("/*")) parseComment(cur);
    else if (c === "_") parseMarker(cur, schema, st);
    else parseEntry(cur, parser, schema, st, userCtx);
  }

  return schema;
}
