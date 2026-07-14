//
// spss/por-read.ts — SPSS portable (.por) reader (port of readstat_por_read.c)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import {
  ReadStatType,
  ReadStatMetadata,
  makeEmptyMetadata,
  HandlerStatus,
  ReadStatSeek,
} from "../types.js";
import { IoContext } from "../io.js";
import { ReadStatParser } from "../parser.js";
import { ReadStatValue, makeStringValue, makeDoubleValue } from "../value.js";
import { Variable } from "../variable.js";
import {
  SpssVarinfo,
  makeVarinfo,
  spssMissingnessForInfo,
  spssFormatToString,
} from "./spss.js";
import { POR_LINE_LENGTH, POR_ASCII_LOOKUP, POR_UNICODE_LOOKUP, porDecode, porParseDouble } from "./por.js";

const POR_FORMAT_SHIFT = 82;
const LABEL_NAME_PREFIX = "labels";
const MAX_STRING_LENGTH = 20000;

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

class PorReadCtx {
  io: IoContext;
  parser: ReadStatParser;
  userCtx: unknown;
  pos = 0;
  numSpaces = 0;
  space = 0x20;
  byte2unicode = new Array(256).fill(0);
  timestamp = 0;
  version = 0;
  fileLabel = "";
  fweightName = "";
  base30Precision = 20;

  varCount = 0;
  varOffset = -1;
  obsCount = 0;
  rowLimit = 0;
  rowOffset = 0;
  labelsOffset = 0;

  varinfo: SpssVarinfo[] = [];
  names: string[] = [];
  variables: (Variable | null)[] = [];
  varDict = new Map<string, number>(); // name -> varinfo index

  constructor(io: IoContext, parser: ReadStatParser, userCtx: unknown) {
    this.io = io;
    this.parser = parser;
    this.userCtx = userCtx;
    this.rowLimit = parser.rowLimit;
    if (parser.rowOffset > 0) this.rowOffset = parser.rowOffset;
  }

  /** Read the next logical byte, unwrapping 80-char lines. null at EOF. */
  private nextByte(): number | null {
    for (;;) {
      if (this.numSpaces) {
        this.numSpaces--;
        return this.space;
      }
      const b = this.io.read(1);
      if (b.length === 0) return null;
      const byte = b[0];
      if (byte === 0x0d || byte === 0x0a) {
        if (byte === 0x0d) {
          const nb = this.io.read(1);
          if (nb.length === 0 || nb[0] !== 0x0a) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        }
        this.numSpaces = POR_LINE_LENGTH - this.pos;
        this.pos = 0;
        continue;
      } else if (this.pos === POR_LINE_LENGTH) {
        throw new ReadStatException(ReadStatError.ERROR_PARSE);
      }
      this.pos++;
      return byte;
    }
  }

  readBytes(len: number): Uint8Array {
    const out = new Uint8Array(len);
    let n = 0;
    while (n < len) {
      const b = this.nextByte();
      if (b === null) break;
      out[n++] = b;
    }
    return out.subarray(0, n);
  }

  readByte(): number {
    const b = this.nextByte();
    if (b === null) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    return b;
  }

  readTag(): number {
    const b = this.readBytes(1);
    if (b.length !== 1) return 0xffff;
    return this.byte2unicode[b[0]];
  }

  readDoubleWithPeek(peek: number): number {
    const buffer = new Uint8Array(100);
    buffer[0] = peek;
    buffer[1] = this.readByte();
    if (this.byte2unicode[buffer[0]] === 0x2a /* * */ && this.byte2unicode[buffer[1]] === 0x2e /* . */) {
      return NaN;
    }
    let i = 2;
    while (i < buffer.length && this.byte2unicode[buffer[i - 1]] !== 0x2f /* / */) {
      buffer[i] = this.readByte();
      i++;
    }
    if (i === buffer.length) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const decoded = porDecode(buffer, i, this.byte2unicode);
    if (decoded === null) throw new ReadStatException(ReadStatError.ERROR_CONVERT);
    const parsed = porParseDouble(decoded);
    if (parsed === null) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    return parsed.value;
  }

  readDouble(): number {
    const peek = this.readByte();
    return this.readDoubleWithPeek(peek);
  }

  readIntegerInRange(min: number, max: number): number {
    const d = this.readDouble();
    if (Number.isNaN(d) || d < min || d > max) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    return Math.trunc(d);
  }

  maybeReadDouble(): { value: number; finished: boolean } {
    const peek = this.readByte();
    if (this.byte2unicode[peek] === 0x5a /* Z */) {
      return { value: NaN, finished: true };
    }
    return { value: this.readDoubleWithPeek(peek), finished: false };
  }

  maybeReadString(): { value: string | null; finished: boolean } {
    const r = this.maybeReadDouble();
    if (r.finished) return { value: null, finished: true };
    const value = r.value;
    if (value < 0 || value > MAX_STRING_LENGTH || Number.isNaN(value)) {
      throw new ReadStatException(ReadStatError.ERROR_PARSE);
    }
    const stringLength = value | 0;
    const raw = this.readBytes(stringLength);
    if (raw.length !== stringLength) throw new ReadStatException(ReadStatError.ERROR_READ);
    const decoded = porDecode(raw, stringLength, this.byte2unicode);
    if (decoded === null) throw new ReadStatException(ReadStatError.ERROR_CONVERT);
    return { value: decoded, finished: false };
  }

  readString(): string {
    const r = this.maybeReadString();
    if (r.finished) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    return r.value!;
  }
}

function readVariableCountRecord(ctx: PorReadCtx): void {
  if (ctx.varCount) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.varCount = ctx.readIntegerInRange(0, 1000000);
  ctx.varinfo = [];
  ctx.names = [];
  ctx.variables = new Array(ctx.varCount).fill(null);
  for (let i = 0; i < ctx.varCount; i++) {
    ctx.varinfo[i] = makeVarinfo();
    ctx.names[i] = "";
  }
  if (ctx.parser.handlers.metadata) {
    const metadata: ReadStatMetadata = makeEmptyMetadata();
    metadata.rowCount = -1;
    metadata.varCount = ctx.varCount;
    metadata.creationTime = ctx.timestamp;
    metadata.modifiedTime = ctx.timestamp;
    metadata.fileFormatVersion = ctx.version;
    metadata.fileLabel = ctx.fileLabel;
    if (hstatus(ctx.parser.handlers.metadata(metadata, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }
}

function readVariableRecord(ctx: PorReadCtx): void {
  ctx.varOffset++;
  if (ctx.varOffset === ctx.varCount) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const info = ctx.varinfo[ctx.varOffset];
  info.labelsIndex = -1;
  const width = ctx.readIntegerInRange(0, 1000000);
  info.width = width;
  info.type = width === 0 ? ReadStatType.DOUBLE : ReadStatType.STRING;
  const name = ctx.readString();
  ctx.names[ctx.varOffset] = name;
  ctx.varDict.set(name, ctx.varOffset);

  const formats = [info.printFormat, info.writeFormat];
  for (const format of formats) {
    let value = ctx.readIntegerInRange(0, POR_FORMAT_SHIFT + 41);
    format.type = value > POR_FORMAT_SHIFT ? value - POR_FORMAT_SHIFT : value;
    format.width = ctx.readIntegerInRange(0, 20000);
    format.decimalPlaces = ctx.readIntegerInRange(0, 100);
  }
}

function readMissingValueRecord(ctx: PorReadCtx): void {
  if (ctx.varOffset < 0 || ctx.varOffset >= ctx.varCount) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const info = ctx.varinfo[ctx.varOffset];
  if (info.nMissingValues >= 3) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (info.type === ReadStatType.DOUBLE) {
    info.missingDoubleValues[info.nMissingValues] = ctx.readDouble();
  } else {
    info.missingStringValues[info.nMissingValues] = ctx.readString();
  }
  info.nMissingValues++;
}

function readMissingRange(ctx: PorReadCtx, kind: "range" | "lo" | "hi"): void {
  if (ctx.varOffset < 0 || ctx.varOffset === ctx.varCount) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const info = ctx.varinfo[ctx.varOffset];
  info.missingRange = 1;
  info.nMissingValues = 2;
  if (info.type === ReadStatType.DOUBLE) {
    if (kind === "lo") {
      info.missingDoubleValues[0] = -Infinity;
      info.missingDoubleValues[1] = ctx.readDouble();
    } else if (kind === "hi") {
      info.missingDoubleValues[0] = ctx.readDouble();
      info.missingDoubleValues[1] = Infinity;
    } else {
      info.missingDoubleValues[0] = ctx.readDouble();
      info.missingDoubleValues[1] = ctx.readDouble();
    }
  } else {
    if (kind === "lo") {
      info.missingStringValues[0] = "";
      info.missingStringValues[1] = ctx.readString();
    } else if (kind === "hi") {
      info.missingStringValues[0] = ctx.readString();
      info.missingStringValues[1] = "";
    } else {
      info.missingStringValues[0] = ctx.readString();
      info.missingStringValues[1] = ctx.readString();
    }
  }
}

function readVariableLabelRecord(ctx: PorReadCtx): void {
  if (ctx.varOffset < 0 || ctx.varOffset === ctx.varCount) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const info = ctx.varinfo[ctx.varOffset];
  info.label = ctx.readString();
}

function readDocumentRecord(ctx: PorReadCtx): void {
  const lineCount = ctx.readIntegerInRange(0, 1000000);
  for (let i = 0; i < lineCount; i++) {
    const line = ctx.readString();
    if (ctx.parser.handlers.note && hstatus(ctx.parser.handlers.note(i, line, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }
}

function readValueLabelRecord(ctx: PorReadCtx): void {
  const labelName = LABEL_NAME_PREFIX + ctx.labelsOffset;
  let valueType = ReadStatType.DOUBLE;
  const count = ctx.readIntegerInRange(0, 1000000);
  for (let i = 0; i < count; i++) {
    const name = ctx.readString();
    const idx = ctx.varDict.get(name);
    if (idx !== undefined) {
      valueType = ctx.varinfo[idx].type;
      ctx.varinfo[idx].labelsIndex = ctx.labelsOffset;
    }
  }
  const labelCount = ctx.readIntegerInRange(0, 1000000);
  for (let i = 0; i < labelCount; i++) {
    let value: ReadStatValue;
    if (valueType === ReadStatType.STRING) {
      const s = ctx.readString();
      const label = ctx.readString();
      value = makeStringValue(s);
      if (ctx.parser.handlers.valueLabel && hstatus(ctx.parser.handlers.valueLabel(labelName, value, label, ctx.userCtx)) !== HandlerStatus.OK) {
        throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      }
    } else {
      const d = ctx.readDouble();
      const label = ctx.readString();
      value = makeDoubleValue(d);
      value.isSystemMissing = Number.isNaN(d);
      if (ctx.parser.handlers.valueLabel && hstatus(ctx.parser.handlers.valueLabel(labelName, value, label, ctx.userCtx)) !== HandlerStatus.OK) {
        throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      }
    }
  }
  ctx.labelsOffset++;
}

function buildVariable(ctx: PorReadCtx, i: number, indexAfterSkipping: number): Variable {
  const info = ctx.varinfo[i];
  const v = new Variable(info.type, i);
  v.indexAfterSkipping = indexAfterSkipping;
  v.storageWidth = info.stringLength ? info.stringLength : 8 * info.width;
  v.name = ctx.names[i];
  if (info.label) v.label = info.label;
  v.format = spssFormatToString(info.printFormat) ?? "";
  v.missingness = spssMissingnessForInfo(info);
  v.measure = info.measure;
  v.displayWidth = info.printFormat.width;
  return v;
}

function handleVariables(ctx: PorReadCtx): void {
  let indexAfterSkipping = 0;
  for (let i = 0; i < ctx.varCount; i++) {
    const info = ctx.varinfo[i];
    info.index = i;
    const v = buildVariable(ctx, i, indexAfterSkipping);
    ctx.variables[i] = v;
    const valLabels = info.labelsIndex === -1 ? null : LABEL_NAME_PREFIX + info.labelsIndex;
    if (ctx.parser.handlers.variable) {
      const cb = hstatus(ctx.parser.handlers.variable(i, v, valLabels, ctx.userCtx));
      if (cb === HandlerStatus.ABORT) throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      if (cb === HandlerStatus.SKIP_VARIABLE) v.skip = 1;
      else indexAfterSkipping++;
    } else {
      indexAfterSkipping++;
    }
  }
  if (ctx.parser.handlers.fweight && ctx.fweightName) {
    for (let i = 0; i < ctx.varCount; i++) {
      if (ctx.names[i] === ctx.fweightName) {
        const v = ctx.variables[i]!;
        if (hstatus(ctx.parser.handlers.fweight(v, ctx.userCtx)) !== HandlerStatus.OK) {
          throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
        }
        break;
      }
    }
  }
}

function readFileData(ctx: PorReadCtx): void {
  if (ctx.varCount === 0) return;
  const valueHandler = ctx.parser.handlers.value;
  for (;;) {
    for (let i = 0; i < ctx.varCount; i++) {
      const info = ctx.varinfo[i];
      let value: ReadStatValue;
      if (info.type === ReadStatType.STRING) {
        const r = ctx.maybeReadString();
        if (r.finished) {
          if (i !== 0) throw new ReadStatException(ReadStatError.ERROR_PARSE);
          return;
        }
        value = makeStringValue(r.value);
      } else {
        const r = ctx.maybeReadDouble();
        if (r.finished) {
          if (i !== 0) throw new ReadStatException(ReadStatError.ERROR_PARSE);
          return;
        }
        value = makeDoubleValue(r.value);
        value.isSystemMissing = Number.isNaN(r.value);
      }
      if (valueHandler && !ctx.variables[i]!.skip && !ctx.rowOffset) {
        if (hstatus(valueHandler(ctx.obsCount, ctx.variables[i]!, value, ctx.userCtx)) !== HandlerStatus.OK) {
          throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
        }
      }
    }
    if (ctx.rowOffset) ctx.rowOffset--;
    else ctx.obsCount++;
    if (ctx.rowLimit > 0 && ctx.obsCount === ctx.rowLimit) return;
  }
}

function latin1Strip(b: Uint8Array): string {
  let len = b.length;
  while (len > 0 && (b[len - 1] === 0x20 || b[len - 1] === 0x00)) len--;
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[i]);
  return s;
}

function readVersionAndTimestamp(ctx: PorReadCtx): void {
  const version = ctx.readByte();
  const dateStr = ctx.readString();
  const dm = /^(\d{4})(\d{2})(\d{2})/.exec(dateStr);
  if (!dm) throw new ReadStatException(ReadStatError.ERROR_BAD_TIMESTAMP_STRING);
  const timeStr = ctx.readString();
  const tm = /^(\d{2})(\d{2})(\d{2})/.exec(timeStr);
  const year = parseInt(dm[1], 10);
  const mon = parseInt(dm[2], 10) - 1;
  const day = parseInt(dm[3], 10);
  const hour = tm ? parseInt(tm[1], 10) : 0;
  const min = tm ? parseInt(tm[2], 10) : 0;
  const sec = tm ? parseInt(tm[3], 10) : 0;
  ctx.timestamp = Math.floor(new Date(year, mon, day, hour, min, sec).getTime() / 1000);
  ctx.version = ctx.byte2unicode[version] - 0x41;
}

export function parsePor(parser: ReadStatParser, io: IoContext, userCtx: unknown): ReadStatError {
  const ctx = new PorReadCtx(io, parser, userCtx);
  try {
    io.seek(0, ReadStatSeek.END);
    io.seek(0, ReadStatSeek.SET);

    const vanity = ctx.readBytes(200);
    if (vanity.length !== 200) return ReadStatError.ERROR_READ;
    ctx.fileLabel = latin1Strip(vanity.subarray(60, 80));

    const reverseLookup = ctx.readBytes(256);
    if (reverseLookup.length !== 256) return ReadStatError.ERROR_READ;
    ctx.space = reverseLookup[126];
    for (let i = 0; i < 256; i++) {
      if (POR_ASCII_LOOKUP[i]) ctx.byte2unicode[reverseLookup[i]] = POR_ASCII_LOOKUP[i];
      else if (POR_UNICODE_LOOKUP[i]) ctx.byte2unicode[reverseLookup[i]] = POR_UNICODE_LOOKUP[i];
    }
    ctx.byte2unicode[reverseLookup[64]] = POR_UNICODE_LOOKUP[64];

    const check = ctx.readBytes(8);
    if (check.length !== 8) return ReadStatError.ERROR_READ;
    const decoded = porDecode(check, 8, ctx.byte2unicode);
    if (decoded === null || decoded !== "SPSSPORT") return ReadStatError.ERROR_PARSE;

    ctx.varOffset = -1;
    readVersionAndTimestamp(ctx);

    for (;;) {
      const tag = ctx.readTag();
      const tagChar = String.fromCharCode(tag);
      switch (tagChar) {
        case "1":
        case "2":
        case "3":
          ctx.readString();
          break;
        case "4":
          readVariableCountRecord(ctx);
          break;
        case "5":
          ctx.base30Precision = ctx.readIntegerInRange(0, 100);
          break;
        case "6":
          ctx.fweightName = ctx.readString();
          break;
        case "7":
          readVariableRecord(ctx);
          break;
        case "8":
          readMissingValueRecord(ctx);
          break;
        case "B":
          readMissingRange(ctx, "range");
          break;
        case "9":
          readMissingRange(ctx, "lo");
          break;
        case "A":
          readMissingRange(ctx, "hi");
          break;
        case "C":
          readVariableLabelRecord(ctx);
          break;
        case "D":
          readValueLabelRecord(ctx);
          break;
        case "E":
          readDocumentRecord(ctx);
          break;
        case "F":
          if (ctx.varOffset !== ctx.varCount - 1) return ReadStatError.ERROR_COLUMN_COUNT_MISMATCH;
          handleVariables(ctx);
          if (parser.handlers.value) readFileData(ctx);
          return ReadStatError.OK;
        default:
          return ReadStatError.ERROR_PARSE;
      }
    }
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    throw e;
  }
}
