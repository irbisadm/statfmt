//
// txt/schema.ts — schema structures and shared helpers for text/command parsing
// (port of readstat_schema.c, readstat_copy.c, commands_util.c)
//

import { ReadStatType, HandlerStatus } from "../types.js";
import { Variable } from "../variable.js";
import { ReadStatParser } from "../parser.js";
import { ReadStatValue, makeDoubleValue, makeStringValue } from "../value.js";
import { ReadStatError } from "../errors.js";

export interface SchemaEntry {
  row: number;
  col: number;
  len: number;
  skip: number;
  variable: Variable;
  labelset: string;
  decimalSeparator: string;
}

export interface Schema {
  filename: string;
  rowsPerObservation: number;
  colsPerObservation: number;
  firstLine: number;
  fieldDelimiter: string; // "" for fixed-width
  entries: SchemaEntry[];
}

export function makeSchema(): Schema {
  return { filename: "", rowsPerObservation: 0, colsPerObservation: 0, firstLine: 0, fieldDelimiter: "", entries: [] };
}

export function makeSchemaEntry(index: number): SchemaEntry {
  const variable = new Variable(ReadStatType.DOUBLE, index);
  return { row: 0, col: 0, len: 0, skip: 0, variable, labelset: "", decimalSeparator: "." };
}

export function schemaFindOrCreateEntry(schema: Schema, varName: string): SchemaEntry {
  for (const e of schema.entries) {
    if (e.variable.name === varName) return e;
  }
  const entry = makeSchemaEntry(schema.entries.length);
  entry.variable.name = varName;
  schema.entries.push(entry);
  return entry;
}

// ---- string copy helpers ----

export function copyQuoted(str: string): string {
  let out = "";
  let slash = false;
  for (const ch of str) {
    if (slash) {
      out += ch === "t" ? "\t" : ch;
      slash = false;
    } else if (ch === "\\") {
      slash = true;
    } else {
      out += ch;
    }
  }
  return out;
}

// ---- shared submit helpers (SAS/SPSS command parsers) ----

export enum LabelType {
  OTHER,
  RANGE,
  DOUBLE,
  STRING,
  NAN,
}

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

export function submitValueLabel(
  parser: ReadStatParser,
  labelset: string,
  labelType: LabelType,
  firstInteger: number,
  lastInteger: number,
  doubleValue: number,
  stringValue: string,
  buf: string,
  userCtx: unknown,
): ReadStatError {
  if (!parser.handlers.valueLabel) return ReadStatError.OK;
  const emit = (value: ReadStatValue): boolean =>
    hstatus(parser.handlers.valueLabel!(labelset, value, buf, userCtx)) === HandlerStatus.OK;

  if (labelType === LabelType.RANGE) {
    for (let i = firstInteger; i <= lastInteger; i++) {
      if (!emit(makeDoubleValue(i))) return ReadStatError.ERROR_USER_ABORT;
    }
  } else if (labelType !== LabelType.OTHER) {
    let value: ReadStatValue;
    if (labelType === LabelType.DOUBLE) value = makeDoubleValue(doubleValue);
    else if (labelType === LabelType.STRING) value = makeStringValue(stringValue);
    else value = makeDoubleValue(NaN);
    if (!emit(value)) return ReadStatError.ERROR_USER_ABORT;
  }
  return ReadStatError.OK;
}

export function submitColumns(parser: ReadStatParser, schema: Schema, userCtx: unknown): ReadStatError {
  for (const entry of schema.entries) {
    if (schema.rowsPerObservation < entry.row + 1) schema.rowsPerObservation = entry.row + 1;
  }
  if (!parser.handlers.variable) return ReadStatError.OK;
  let partial = 0;
  for (let i = 0; i < schema.entries.length; i++) {
    const entry = schema.entries[i];
    entry.variable.index = i;
    entry.variable.indexAfterSkipping = partial;
    if (entry.variable.type === ReadStatType.STRING) entry.variable.storageWidth = entry.len;
    const cb = hstatus(parser.handlers.variable(i, entry.variable, entry.labelset || null, userCtx));
    if (cb === HandlerStatus.SKIP_VARIABLE) entry.skip = 1;
    else if (cb === HandlerStatus.ABORT) return ReadStatError.ERROR_USER_ABORT;
    else partial++;
  }
  return ReadStatError.OK;
}
