//
// txt/txt-read.ts — read plain-text data using a parsed schema
// (port of readstat_txt_read.c)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import { ReadStatType, ReadStatMetadata, makeEmptyMetadata, HandlerStatus } from "../types.js";
import { IoContext } from "../io.js";
import { ReadStatParser } from "../parser.js";
import { convertString } from "../codec.js";
import { ReadStatValue, makeStringValue } from "../value.js";
import { Schema, SchemaEntry } from "./schema.js";

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

class TxtReader {
  parser: ReadStatParser;
  io: IoContext;
  schema: Schema;
  userCtx: unknown;
  srcEncoding: string;
  rows = 0;

  constructor(parser: ReadStatParser, io: IoContext, schema: Schema, userCtx: unknown) {
    this.parser = parser;
    this.io = io;
    this.schema = schema;
    this.userCtx = userCtx;
    this.srcEncoding = parser.inputEncoding ?? "utf-8";
  }

  handleValue(obsIndex: number, entry: SchemaEntry, bytes: Uint8Array, len: number): void {
    const variable = entry.variable;
    let value: ReadStatValue;
    if (variable.type === ReadStatType.STRING) {
      value = makeStringValue(convertString(this.parser.codec, bytes, this.srcEncoding, 0, len));
    } else {
      const s = latin1(bytes, 0, len);
      value = new ReadStatValue(variable.type === ReadStatType.DOUBLE || variable.type === ReadStatType.FLOAT ? variable.type : ReadStatType.INT32);
      if (variable.type === ReadStatType.DOUBLE || variable.type === ReadStatType.FLOAT) {
        const d = parseFloat(s);
        value.num = d;
        value.isSystemMissing = Number.isNaN(d);
      } else {
        const n = parseInt(s, 10);
        value.type = ReadStatType.INT32;
        value.num = Number.isNaN(n) ? 0 : n;
        value.isSystemMissing = Number.isNaN(n);
      }
    }
    if (hstatus(this.parser.handlers.value!(obsIndex, variable, value, this.userCtx)) === HandlerStatus.ABORT) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }

  /** Read one byte or -1 at EOF. */
  private readByte(): number {
    const b = this.io.read(1);
    return b.length === 0 ? -1 : b[0];
  }

  /** getdelim: read until delimiter, returning bytes read incl. delimiter (0 at EOF). */
  private getdelim(delimiter: number): { buf: Uint8Array; count: number } {
    const chunks: number[] = [];
    for (;;) {
      const c = this.readByte();
      if (c === -1) break;
      chunks.push(c);
      if (c === delimiter) break;
    }
    return { buf: Uint8Array.from(chunks), count: chunks.length };
  }

  parseDelimited(): void {
    const schema = this.schema;
    let k = 0;
    for (;;) {
      for (let j = 0; j < schema.entries.length; j++) {
        const entry = schema.entries[j];
        const delimiter = j === schema.entries.length - 1 ? 0x0a : schema.fieldDelimiter.charCodeAt(0);
        const { buf, count } = this.getdelim(delimiter);
        if (count === 0) {
          this.rows = k;
          return;
        }
        if (this.parser.handlers.value && !entry.skip) {
          let charsRead = count - 1; // strip delimiter
          if (charsRead > 0 && buf[charsRead - 1] === 0x0d) charsRead--; // CRLF
          this.handleValue(k, entry, buf, charsRead);
        }
      }
      if (++k === this.parser.rowLimit) break;
    }
    this.rows = k;
  }

  parseFixedWidth(lineLens: number[]): void {
    const schema = this.schema;
    let k = 0;
    for (;;) {
      let j = 0;
      for (let i = 0; i < schema.rowsPerObservation; i++) {
        const line = this.io.read(lineLens[i]);
        if (line.length === 0) {
          this.rows = k;
          return;
        }
        if (line.length < lineLens[i]) throw new ReadStatException(ReadStatError.ERROR_READ);
        for (; j < schema.entries.length && schema.entries[j].row === i; j++) {
          const entry = schema.entries[j];
          const fieldLen = entry.len;
          const fieldOffset = entry.col;
          if (this.parser.handlers.value && !entry.skip) {
            this.handleValue(k, entry, line.subarray(fieldOffset, fieldOffset + fieldLen), fieldLen);
          }
        }
        if (schema.colsPerObservation === 0) {
          // consume to end of line
          for (;;) {
            const c = this.readByte();
            if (c === -1 || c === 0x0a) break;
          }
        }
      }
      if (++k === this.parser.rowLimit) break;
    }
    this.rows = k;
  }
}

function latin1(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

export function parseTxt(parser: ReadStatParser, io: IoContext, schema: Schema, userCtx: unknown): ReadStatError {
  const reader = new TxtReader(parser, io, schema, userCtx);
  try {
    const lineLens = new Array<number>(schema.rowsPerObservation).fill(schema.colsPerObservation);
    for (const entry of schema.entries) {
      if (lineLens[entry.row] < entry.col + entry.len) lineLens[entry.row] = entry.col + entry.len;
    }

    if (schema.firstLine > 1) {
      let throwaway = schema.firstLine - 1;
      while (throwaway--) {
        for (;;) {
          const b = io.read(1);
          if (b.length === 0 || b[0] === 0x0a) break;
        }
      }
    }

    if (schema.fieldDelimiter) reader.parseDelimited();
    else reader.parseFixedWidth(lineLens);

    if (parser.handlers.metadata) {
      const metadata: ReadStatMetadata = makeEmptyMetadata();
      metadata.rowCount = reader.rows;
      metadata.varCount = schema.entries.length;
      if (hstatus(parser.handlers.metadata(metadata, userCtx)) === HandlerStatus.ABORT) {
        return ReadStatError.ERROR_USER_ABORT;
      }
    }
    return ReadStatError.OK;
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    throw e;
  }
}
