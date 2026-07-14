//
// sas/xport-read.ts — SAS transport (.xpt) reader (port of readstat_xport_read.c)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import {
  ReadStatType,
  ReadStatAlignment,
  ReadStatMetadata,
  makeEmptyMetadata,
  HandlerStatus,
  ReadStatSeek,
} from "../types.js";
import { IoContext, ioReadExact, IoReadError } from "../io.js";
import { ReadStatParser } from "../parser.js";
import { Codec, convertString } from "../codec.js";
import { ReadStatValue, makeStringValue, makeDoubleValue } from "../value.js";
import { Variable } from "../variable.js";
import { SAS_COLUMN_TYPE_CHR, XPORT_MONTHS, sasValidateTag } from "./sas.js";
import { xptToIeeeBytes } from "./ieee.js";

const LINE_LEN = 80;
const XPORT_MIN_DOUBLE_SIZE = 3;
const XPORT_MAX_DOUBLE_SIZE = 8;

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}
function latin1(b: Uint8Array, off = 0, len = b.length - off): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

interface XportHeader {
  name: string;
  num1: number;
  num2: number;
  num3: number;
  num4: number;
  num5: number;
  num6: number;
}

class XportReadCtx {
  io: IoContext;
  parser: ReadStatParser;
  codec: Codec;
  userCtx: unknown;
  srcEncoding: string;
  version = 5;
  timestamp = 0;
  fileLabel = "";
  tableName = "";
  varCount = 0;
  rowLength = 0;
  rowLimit = 0;
  rowOffset = 0;
  parsedRowCount = 0;
  variables: Variable[] = [];

  constructor(io: IoContext, parser: ReadStatParser, userCtx: unknown) {
    this.io = io;
    this.parser = parser;
    this.codec = parser.codec;
    this.userCtx = userCtx;
    this.srcEncoding = parser.inputEncoding ?? "utf-8";
    this.rowLimit = parser.rowLimit;
    if (parser.rowOffset > 0) this.rowOffset = parser.rowOffset;
  }
  conv(b: Uint8Array, off = 0, len = b.length - off): string {
    return convertString(this.codec, b, this.srcEncoding, off, len);
  }
  readRecord(): Uint8Array {
    return ioReadExact(this.io, LINE_LEN);
  }
  skipRecord(): void {
    if (this.io.seek(LINE_LEN, ReadStatSeek.CUR) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
  }
  skipRestOfRecord(): void {
    const pos = this.io.tell();
    if (pos % LINE_LEN) {
      if (this.io.seek(LINE_LEN - (pos % LINE_LEN), ReadStatSeek.CUR) === -1) {
        throw new ReadStatException(ReadStatError.ERROR_SEEK);
      }
    }
  }
}

function parseHeaderRecord(line: string): XportHeader {
  const m = /^HEADER RECORD\*{7}(.{8})HEADER RECORD!{7}([\s\S]*)$/.exec(line);
  if (!m) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const rest = m[2];
  const num = (k: number) => {
    const s = rest.slice(k * 5, k * 5 + 5);
    const v = parseInt(s, 10);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    name: m[1].trim(),
    num1: num(0),
    num2: num(1),
    num3: num(2),
    num4: num(3),
    num5: num(4),
    num6: num(5),
  };
}

function readHeaderRecord(ctx: XportReadCtx): XportHeader {
  return parseHeaderRecord(latin1(ctx.readRecord()));
}

function expectHeaderRecord(ctx: XportReadCtx, v5Name: string, v8Name: string): void {
  const rec = readHeaderRecord(ctx);
  if (ctx.version === 5 && rec.name !== v5Name) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (ctx.version === 8 && rec.name !== v8Name) throw new ReadStatException(ReadStatError.ERROR_PARSE);
}

function readLibraryRecord(ctx: XportReadCtx): void {
  const rec = readHeaderRecord(ctx);
  if (rec.name === "LIBRARY") ctx.version = 5;
  else if (rec.name === "LIBV8") ctx.version = 8;
  else throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION);
}

function readTimestampRecord(ctx: XportReadCtx): void {
  const line = latin1(ctx.readRecord());
  const m = /^(\d{2})(\w{3})(\d{2}):(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!m) return;
  const mday = parseInt(m[1], 10);
  const monIdx = XPORT_MONTHS.indexOf(m[2].toUpperCase());
  let year = parseInt(m[3], 10);
  if (year < 60) year += 100;
  const hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = parseInt(m[6], 10);
  const d = new Date(year + 1900, monIdx < 0 ? 0 : monIdx, mday, hour, min, sec);
  ctx.timestamp = Math.floor(d.getTime() / 1000);
}

function readTableNameRecord(ctx: XportReadCtx): void {
  const line = ctx.readRecord();
  ctx.tableName = ctx.conv(line, 8, ctx.version === 5 ? 8 : 32);
}
function readFileLabelRecord(ctx: XportReadCtx): void {
  const line = ctx.readRecord();
  ctx.fileLabel = ctx.conv(line, 32, 40);
}

function readNamestrHeaderRecord(ctx: XportReadCtx): void {
  const rec = readHeaderRecord(ctx);
  if (ctx.version === 5 && rec.name !== "NAMESTR") throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (ctx.version === 8 && rec.name !== "NAMSTV8") throw new ReadStatException(ReadStatError.ERROR_PARSE);
  ctx.varCount = rec.num2;
  ctx.variables = new Array(ctx.varCount);
  if (ctx.parser.handlers.metadata) {
    const metadata: ReadStatMetadata = makeEmptyMetadata();
    metadata.rowCount = -1;
    metadata.varCount = ctx.varCount;
    metadata.fileLabel = ctx.fileLabel;
    metadata.tableName = ctx.tableName;
    metadata.creationTime = ctx.timestamp;
    metadata.modifiedTime = ctx.timestamp;
    metadata.fileFormatVersion = ctx.version;
    if (hstatus(ctx.parser.handlers.metadata(metadata, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
  }
}

function constructFormat(ctx: XportReadCtx, nform: Uint8Array, width: number, decimals: number): string {
  const name = ctx.conv(nform, 0, nform.length);
  let out = name;
  if (width) out += String(width);
  if (decimals) out += "." + decimals;
  return out;
}

function readVariables(ctx: XportReadCtx): void {
  for (let i = 0; i < ctx.varCount; i++) {
    const ns = ioReadExact(ctx.io, 140);
    const dv = new DataView(ns.buffer, ns.byteOffset, 140);
    const ntype = dv.getUint16(0, false);
    const nlng = dv.getUint16(4, false);
    const nfl = dv.getUint16(64, false);
    const nfd = dv.getUint16(66, false);
    const nfj = dv.getUint16(68, false);

    const variable = new Variable(ntype === SAS_COLUMN_TYPE_CHR ? ReadStatType.STRING : ReadStatType.DOUBLE, i);
    variable.storageWidth = nlng;
    variable.displayWidth = nfl;
    variable.decimals = nfd;
    variable.alignment = nfj ? ReadStatAlignment.RIGHT : ReadStatAlignment.LEFT;

    if (ctx.version === 5) {
      variable.name = ctx.conv(ns, 8, 8); // nname
    } else {
      variable.name = ctx.conv(ns, 88, 32); // longname
    }
    variable.label = ctx.conv(ns, 16, 40); // nlabel
    variable.format = constructFormat(ctx, ns.subarray(56, 64), nfl, nfd); // nform

    ctx.variables[i] = variable;
  }

  ctx.skipRestOfRecord();

  if (ctx.version === 5) {
    expectHeaderRecord(ctx, "OBS", "OBSV8");
  } else {
    const rec = readHeaderRecord(ctx);
    if (rec.name === "OBSV8") {
      /* void */
    } else if (rec.name === "LABELV8") {
      readLabelsV8(ctx, rec.num1, false);
    } else if (rec.name === "LABELV9") {
      readLabelsV8(ctx, rec.num1, true);
    }
  }

  ctx.rowLength = 0;
  let indexAfterSkipping = 0;
  for (let i = 0; i < ctx.varCount; i++) {
    const variable = ctx.variables[i];
    variable.indexAfterSkipping = indexAfterSkipping;
    if (ctx.parser.handlers.variable) {
      const cb = hstatus(ctx.parser.handlers.variable(i, variable, variable.format || null, ctx.userCtx));
      if (cb === HandlerStatus.ABORT) throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      if (cb === HandlerStatus.SKIP_VARIABLE) variable.skip = 1;
      else indexAfterSkipping++;
    } else {
      indexAfterSkipping++;
    }
    ctx.rowLength += variable.storageWidth;
  }
}

function readLabelsV8(ctx: XportReadCtx, labelCount: number, v9: boolean): void {
  for (let i = 0; i < labelCount; i++) {
    const nFields = v9 ? 5 : 3;
    const def = ioReadExact(ctx.io, nFields * 2);
    const ddv = new DataView(def.buffer, def.byteOffset, def.byteLength);
    const index = ddv.getUint16(0, false);
    const nameLen = ddv.getUint16(2, false);
    const labelLen = ddv.getUint16(4, false);
    const formatLen = v9 ? ddv.getUint16(6, false) : 0;
    const informatLen = v9 ? ddv.getUint16(8, false) : 0;
    if (index > ctx.varCount || index === 0) throw new ReadStatException(ReadStatError.ERROR_PARSE);
    const variable = ctx.variables[index - 1];
    const nameBytes = ioReadExact(ctx.io, nameLen);
    const labelBytes = ioReadExact(ctx.io, labelLen);
    variable.name = ctx.conv(nameBytes, 0, nameLen);
    variable.label = ctx.conv(labelBytes, 0, labelLen);
    if (v9) {
      const formatBytes = ioReadExact(ctx.io, formatLen);
      if (informatLen > 0) ioReadExact(ctx.io, informatLen);
      variable.format = ctx.conv(formatBytes, 0, formatLen);
    }
  }
  ctx.skipRestOfRecord();
  expectHeaderRecord(ctx, "OBS", "OBSV8");
}

function processRow(ctx: XportReadCtx, row: Uint8Array): void {
  let pos = 0;
  for (let i = 0; i < ctx.varCount; i++) {
    const variable = ctx.variables[i];
    let value: ReadStatValue;
    if (variable.type === ReadStatType.STRING) {
      value = makeStringValue(ctx.conv(row, pos, variable.storageWidth));
    } else {
      const width = variable.storageWidth;
      let dval = NaN;
      value = makeDoubleValue(NaN);
      if (width >= XPORT_MIN_DOUBLE_SIZE && width <= XPORT_MAX_DOUBLE_SIZE) {
        let restZero = true;
        for (let k = 1; k < width; k++) if (row[pos + k] !== 0) { restZero = false; break; }
        const first = row[pos];
        if (restZero && (first === 0x2e || sasValidateTag(first) === ReadStatError.OK)) {
          if (first === 0x2e) {
            value.isSystemMissing = true;
          } else {
            value.tag = String.fromCharCode(first);
            value.isTaggedMissing = true;
          }
          value.num = NaN;
        } else {
          const full = new Uint8Array(8);
          full.set(row.subarray(pos, pos + width));
          const ieee = xptToIeeeBytes(full);
          dval = new DataView(ieee.buffer, ieee.byteOffset, 8).getFloat64(0, false);
          value.num = dval;
          value.isSystemMissing = false;
        }
      }
    }
    pos += variable.storageWidth;
    if (ctx.parser.handlers.value && !variable.skip && !ctx.rowOffset) {
      if (hstatus(ctx.parser.handlers.value(ctx.parsedRowCount, variable, value, ctx.userCtx)) !== HandlerStatus.OK) {
        throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
      }
    }
  }
  if (ctx.rowOffset) ctx.rowOffset--;
  else ctx.parsedRowCount++;
}

function readData(ctx: XportReadCtx): void {
  if (!ctx.rowLength || !ctx.parser.handlers.value) return;
  const blankRow = new Uint8Array(ctx.rowLength).fill(0x20);
  let numBlankRows = 0;
  for (;;) {
    const row = ctx.io.read(ctx.rowLength);
    if (row.length < ctx.rowLength) break;
    let rowIsBlank = true;
    for (let p = 0; p < ctx.rowLength; p++) {
      if (row[p] !== 0x20) {
        rowIsBlank = false;
        break;
      }
    }
    if (rowIsBlank) {
      numBlankRows++;
      continue;
    }
    while (numBlankRows) {
      processRow(ctx, blankRow);
      if (ctx.rowLimit > 0 && ctx.parsedRowCount === ctx.rowLimit) return;
      numBlankRows--;
    }
    processRow(ctx, row.slice());
    if (ctx.rowLimit > 0 && ctx.parsedRowCount === ctx.rowLimit) break;
  }
}

export function parseXport(parser: ReadStatParser, io: IoContext, userCtx: unknown): ReadStatError {
  const ctx = new XportReadCtx(io, parser, userCtx);
  try {
    io.seek(0, ReadStatSeek.END);
    io.seek(0, ReadStatSeek.SET);

    readLibraryRecord(ctx);
    ctx.skipRecord();
    readTimestampRecord(ctx);
    expectHeaderRecord(ctx, "MEMBER", "MEMBV8");
    expectHeaderRecord(ctx, "DSCRPTR", "DSCPTV8");
    readTableNameRecord(ctx);
    readFileLabelRecord(ctx);
    readNamestrHeaderRecord(ctx);
    readVariables(ctx);
    if (ctx.rowLength) readData(ctx);
    return ReadStatError.OK;
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    if (e instanceof IoReadError) return ReadStatError.ERROR_READ;
    throw e;
  }
}
