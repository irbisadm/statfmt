//
// stata/dta-read.ts — DTA reader (port of readstat_dta_read.c)
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
import { ReadStatValue, makeStringValue } from "../value.js";
import { Variable } from "../variable.js";
import {
  DtaConfig,
  dtaTypeInfo,
  DtaTypeError,
  DTA_LOHI,
  DTA_HILO,
  DTA_GSO_TYPE_ASCII,
  DTA_113_MISSING_INT8,
  DTA_113_MISSING_INT8_A,
  DTA_113_MISSING_INT16,
  DTA_113_MISSING_INT16_A,
  DTA_113_MISSING_INT32,
  DTA_113_MISSING_INT32_A,
  DTA_113_MISSING_FLOAT,
  DTA_113_MISSING_FLOAT_A,
  DTA_113_MISSING_DOUBLE,
  DTA_113_MISSING_DOUBLE_A,
} from "./dta.js";
import { dtaParseTimestamp } from "./dta-parse-timestamp.js";
import { makeTm } from "../spss/sav-parse-timestamp.js";

const MAX_VALUE_LABEL_LEN = 32000;

function hstatus(r: HandlerStatus | number | void): number {
  return typeof r === "number" ? r : 0;
}

function latin1(b: Uint8Array, off = 0, len = b.length - off): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

function strnlen(b: Uint8Array, off: number, maxLen: number): number {
  let n = 0;
  while (n < maxLen && b[off + n] !== 0) n++;
  return n;
}

class DtaReadCtx {
  io: IoContext;
  parser: ReadStatParser;
  codec: Codec;
  userCtx: unknown;
  cfg!: DtaConfig;
  le = true;
  initialized = false;
  xmlish = false;
  srcEncoding = "UTF-8";

  nvar = 0;
  nobs = 0;
  recordLen = 0;
  rowLimit = 0;
  rowOffset = 0;
  currentRow = 0;
  timestamp = 0;
  dataLabel: string | null = null;

  typlist: number[] = [];
  varlist!: Uint8Array;
  fmtlist!: Uint8Array;
  lbllist!: Uint8Array;
  variableLabels!: Uint8Array;

  variables: (Variable | null)[] = [];
  variableSkip: boolean[] = [];

  strls = new Map<string, Uint8Array>();

  dataOffset = 0;
  strlsOffset = 0;
  valueLabelsOffset = 0;

  constructor(io: IoContext, parser: ReadStatParser, userCtx: unknown) {
    this.io = io;
    this.parser = parser;
    this.codec = parser.codec;
    this.userCtx = userCtx;
  }

  conv(bytes: Uint8Array, off = 0, len = bytes.length - off): string {
    return convertString(this.codec, bytes, this.srcEncoding, off, len);
  }

  bytes(n: number): Uint8Array {
    return ioReadExact(this.io, n);
  }
  seekSet(n: number): void {
    if (this.io.seek(n, ReadStatSeek.SET) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
  }
  seekCur(n: number): void {
    if (this.io.seek(n, ReadStatSeek.CUR) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
  }
  tell(): number {
    return this.io.tell();
  }

  readTag(tag: string): void {
    if (this.initialized && !this.xmlish) return;
    const buf = this.bytes(tag.length);
    if (latin1(buf) !== tag) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  }

  readChunk(startTag: string, len: number, endTag: string): Uint8Array {
    this.readTag(startTag);
    const data = len > 0 ? this.bytes(len) : new Uint8Array(0);
    this.readTag(endTag);
    return data;
  }
}

// ---- value interpretation ----

function interpretInt8(ctx: DtaReadCtx, buf: Uint8Array, off: number): ReadStatValue {
  const value = new ReadStatValue(ReadStatType.INT8);
  const byte = new DataView(buf.buffer, buf.byteOffset + off, 1).getInt8(0);
  if (byte > ctx.cfg.maxInt8) {
    if (ctx.cfg.supportsTaggedMissing && byte > DTA_113_MISSING_INT8) {
      value.tag = String.fromCharCode(0x61 + (byte - DTA_113_MISSING_INT8_A));
      value.isTaggedMissing = true;
    } else {
      value.isSystemMissing = true;
    }
  }
  value.num = byte;
  return value;
}

function interpretInt16(ctx: DtaReadCtx, buf: Uint8Array, off: number): ReadStatValue {
  const value = new ReadStatValue(ReadStatType.INT16);
  const num = new DataView(buf.buffer, buf.byteOffset + off, 2).getInt16(0, ctx.le);
  if (num > ctx.cfg.maxInt16) {
    if (ctx.cfg.supportsTaggedMissing && num > DTA_113_MISSING_INT16) {
      value.tag = String.fromCharCode(0x61 + (num - DTA_113_MISSING_INT16_A));
      value.isTaggedMissing = true;
    } else {
      value.isSystemMissing = true;
    }
  }
  value.num = num;
  return value;
}

function interpretInt32Bytes(ctx: DtaReadCtx, num: number): ReadStatValue {
  const value = new ReadStatValue(ReadStatType.INT32);
  if (num > ctx.cfg.maxInt32) {
    if (ctx.cfg.supportsTaggedMissing && num > DTA_113_MISSING_INT32) {
      value.tag = String.fromCharCode(0x61 + (num - DTA_113_MISSING_INT32_A));
      value.isTaggedMissing = true;
    } else {
      value.isSystemMissing = true;
    }
  }
  value.num = num;
  return value;
}

function interpretInt32(ctx: DtaReadCtx, buf: Uint8Array, off: number): ReadStatValue {
  const num = new DataView(buf.buffer, buf.byteOffset + off, 4).getInt32(0, ctx.le);
  return interpretInt32Bytes(ctx, num);
}

function interpretFloat(ctx: DtaReadCtx, buf: Uint8Array, off: number): ReadStatValue {
  const value = new ReadStatValue(ReadStatType.FLOAT);
  const dv = new DataView(buf.buffer, buf.byteOffset + off, 4);
  const num = dv.getInt32(0, ctx.le);
  if (num > ctx.cfg.maxFloat) {
    if (ctx.cfg.supportsTaggedMissing && num > DTA_113_MISSING_FLOAT) {
      value.tag = String.fromCharCode(0x61 + ((num - DTA_113_MISSING_FLOAT_A) >> 11));
      value.isTaggedMissing = true;
    } else {
      value.isSystemMissing = true;
    }
    value.num = NaN;
  } else {
    value.num = dv.getFloat32(0, ctx.le);
  }
  return value;
}

function interpretDouble(ctx: DtaReadCtx, buf: Uint8Array, off: number): ReadStatValue {
  const value = new ReadStatValue(ReadStatType.DOUBLE);
  const dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
  const num = dv.getBigInt64(0, ctx.le);
  if (num > ctx.cfg.maxDouble) {
    if (ctx.cfg.supportsTaggedMissing && num > DTA_113_MISSING_DOUBLE) {
      value.tag = String.fromCharCode(0x61 + Number((num - DTA_113_MISSING_DOUBLE_A) >> 40n));
      value.isTaggedMissing = true;
    } else {
      value.isSystemMissing = true;
    }
    value.num = NaN;
  } else {
    value.num = dv.getFloat64(0, ctx.le);
  }
  return value;
}

// ---- header parsing ----

function readLegacyHeader(ctx: DtaReadCtx): { dsFormat: number; byteorder: number; nvar: number; nobs: number } {
  const h = ctx.bytes(10); // ds_format, byteorder, filetype, unused, nvar(u16), nobs(u32)
  const dsFormat = h[0];
  const byteorder = h[1];
  const le = byteorder === DTA_LOHI;
  const dv = new DataView(h.buffer, h.byteOffset, 10);
  const nvar = dv.getUint16(4, le);
  const nobs = dv.getUint32(6, le);
  return { dsFormat, byteorder, nvar, nobs };
}

function readXmlishHeader(ctx: DtaReadCtx): { dsFormat: number; byteorder: number; nvar: number; nobs: number } {
  ctx.xmlish = true;
  ctx.readTag("<stata_dta>");
  ctx.readTag("<header>");
  const dsBytes = ctx.readChunk("<release>", 3, "</release>");
  const dsFormat = 100 * (dsBytes[0] - 0x30) + 10 * (dsBytes[1] - 0x30) + (dsBytes[2] - 0x30);
  const boBytes = ctx.readChunk("<byteorder>", 3, "</byteorder>");
  const bo = latin1(boBytes);
  let byteorder: number;
  if (bo === "MSF") byteorder = DTA_HILO;
  else if (bo === "LSF") byteorder = DTA_LOHI;
  else throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const le = byteorder === DTA_LOHI;

  let nvar: number;
  if (dsFormat >= 119) {
    const b = ctx.readChunk("<K>", 4, "</K>");
    nvar = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, le);
  } else {
    const b = ctx.readChunk("<K>", 2, "</K>");
    nvar = new DataView(b.buffer, b.byteOffset, 2).getUint16(0, le);
  }

  let nobs: number;
  if (dsFormat >= 118) {
    const b = ctx.readChunk("<N>", 8, "</N>");
    nobs = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, le));
  } else {
    const b = ctx.readChunk("<N>", 4, "</N>");
    nobs = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, le);
  }
  return { dsFormat, byteorder, nvar, nobs };
}

function readMap(ctx: DtaReadCtx): void {
  if (!ctx.cfg.fileIsXmlish) return;
  const buf = ctx.readChunk("<map>", 14 * 8, "</map>");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  ctx.dataOffset = Number(dv.getBigUint64(9 * 8, ctx.le));
  ctx.strlsOffset = Number(dv.getBigUint64(10 * 8, ctx.le));
  ctx.valueLabelsOffset = Number(dv.getBigUint64(11 * 8, ctx.le));
}

function readDescriptors(ctx: DtaReadCtx): void {
  const cfg = ctx.cfg;
  const buffer = ctx.readChunk("<variable_types>", ctx.nvar * cfg.typlistEntryLen, "</variable_types>");
  ctx.typlist = [];
  if (cfg.typlistEntryLen === 1) {
    for (let i = 0; i < ctx.nvar; i++) ctx.typlist[i] = buffer[i];
  } else {
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let i = 0; i < ctx.nvar; i++) ctx.typlist[i] = dv.getUint16(i * 2, ctx.le);
  }
  ctx.varlist = ctx.readChunk("<varnames>", cfg.variableNameLen * ctx.nvar, "</varnames>");
  ctx.readChunk("<sortlist>", cfg.srtlistLen, "</sortlist>");
  ctx.fmtlist = ctx.readChunk("<formats>", cfg.fmtlistEntryLen * ctx.nvar, "</formats>");
  ctx.lbllist = ctx.readChunk("<value_label_names>", cfg.lbllistEntryLen * ctx.nvar, "</value_label_names>");
  ctx.variableLabels = ctx.readChunk("<variable_labels>", cfg.variableLabelsEntryLen * ctx.nvar, "</variable_labels>");
}

function initVariable(ctx: DtaReadCtx, i: number, indexAfterSkipping: number, type: ReadStatType, maxLen: number): Variable {
  const cfg = ctx.cfg;
  const variable = new Variable(type, i);
  variable.indexAfterSkipping = indexAfterSkipping;
  variable.storageWidth = maxLen;

  const nameOff = cfg.variableNameLen * i;
  variable.name = ctx.conv(ctx.varlist, nameOff, strnlen(ctx.varlist, nameOff, cfg.variableNameLen));

  const labelOff = cfg.variableLabelsEntryLen * i;
  if (ctx.variableLabels[labelOff]) {
    variable.label = ctx.conv(ctx.variableLabels, labelOff, strnlen(ctx.variableLabels, labelOff, cfg.variableLabelsEntryLen));
  }

  const fmtOff = cfg.fmtlistEntryLen * i;
  if (ctx.fmtlist[fmtOff]) {
    variable.format = ctx.conv(ctx.fmtlist, fmtOff, strnlen(ctx.fmtlist, fmtOff, cfg.fmtlistEntryLen));
    if (variable.format[0] === "%") {
      if (variable.format[1] === "-") variable.alignment = ReadStatAlignment.LEFT;
      else if (variable.format[1] === "~") variable.alignment = ReadStatAlignment.CENTER;
      else variable.alignment = ReadStatAlignment.RIGHT;
    }
    const m = /^%-?(\d+)/.exec(variable.format);
    if (m) variable.displayWidth = parseInt(m[1], 10);
  }
  return variable;
}

function handleVariables(ctx: DtaReadCtx): void {
  if (!ctx.parser.handlers.variable) return;
  const cfg = ctx.cfg;
  let indexAfterSkipping = 0;
  for (let i = 0; i < ctx.nvar; i++) {
    const info = dtaTypeInfo(ctx.typlist[i], cfg);
    let type = info.type;
    let maxLen = info.maxLen;
    if (type === ReadStatType.STRING) maxLen++;
    if (type === ReadStatType.STRING_REF) {
      type = ReadStatType.STRING;
      maxLen = 0;
    }
    const variable = initVariable(ctx, i, indexAfterSkipping, type, maxLen);
    ctx.variables[i] = variable;

    const lblOff = cfg.lbllistEntryLen * i;
    const valueLabels = ctx.lbllist[lblOff]
      ? ctx.conv(ctx.lbllist, lblOff, strnlen(ctx.lbllist, lblOff, cfg.lbllistEntryLen))
      : null;

    const cb = hstatus(ctx.parser.handlers.variable(i, variable, valueLabels, ctx.userCtx));
    if (cb === HandlerStatus.ABORT) throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    if (cb === HandlerStatus.SKIP_VARIABLE) {
      variable.skip = 1;
      ctx.variableSkip[i] = true;
    } else {
      indexAfterSkipping++;
    }
  }
}

function readLabelAndTimestamp(ctx: DtaReadCtx): void {
  const cfg = ctx.cfg;
  let labelLen = 0;
  let lastDataLabelChar = 0;

  if (cfg.fileIsXmlish) {
    ctx.readTag("<label>");
    if (cfg.dataLabelLenLen === 2) {
      const b = ctx.bytes(2);
      labelLen = new DataView(b.buffer, b.byteOffset, 2).getUint16(0, ctx.le);
    } else if (cfg.dataLabelLenLen === 1) {
      labelLen = ctx.bytes(1)[0];
    }
  } else {
    labelLen = cfg.dataLabelLen;
  }

  let dataLabelBuf = ctx.bytes(labelLen);
  if (!cfg.fileIsXmlish) {
    lastDataLabelChar = dataLabelBuf[labelLen - 1];
    labelLen = strnlen(dataLabelBuf, 0, labelLen);
  }
  ctx.dataLabel = ctx.conv(dataLabelBuf, 0, labelLen);

  let timestampLen = 0;
  if (cfg.fileIsXmlish) {
    ctx.readTag("</label>");
    ctx.readTag("<timestamp>");
    timestampLen = ctx.bytes(1)[0];
  } else {
    timestampLen = cfg.timestampLen;
  }

  if (timestampLen) {
    let tsBuf = ctx.bytes(timestampLen);
    let effLen = timestampLen;
    if (!cfg.fileIsXmlish) effLen--;
    if (tsBuf[0]) {
      if (tsBuf[effLen - 1] === 0 && lastDataLabelChar !== 0) {
        // off-by-one hack for miswritten DTA 114-era files
        const shifted = new Uint8Array(effLen);
        shifted[0] = lastDataLabelChar;
        shifted.set(tsBuf.subarray(0, effLen - 1), 1);
        tsBuf = shifted;
      }
      const tm = makeTm();
      const tsStr = latin1(tsBuf, 0, effLen);
      if (dtaParseTimestamp(tsStr, tm) === ReadStatError.OK) {
        const d = new Date(tm.tm_year + 1900, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
        ctx.timestamp = Math.floor(d.getTime() / 1000);
      }
    }
  }

  ctx.readTag("</timestamp>");
}

function readExpansionFields(ctx: DtaReadCtx): void {
  const cfg = ctx.cfg;
  if (cfg.expansionLenLen === 0) return;

  if (cfg.fileIsXmlish && !ctx.parser.handlers.note) {
    ctx.seekSet(ctx.dataOffset);
    return;
  }

  ctx.readTag("<characteristics>");
  for (;;) {
    let dataType: number;
    if (cfg.fileIsXmlish) {
      const start = ctx.bytes(4);
      const s = latin1(start);
      if (s === "</ch") {
        ctx.readTag("aracteristics>");
        break;
      } else if (s !== "<ch>") {
        throw new ReadStatException(ReadStatError.ERROR_PARSE);
      }
      dataType = 1;
    } else {
      dataType = ctx.bytes(1)[0];
    }

    let len: number;
    if (cfg.expansionLenLen === 2) {
      const b = ctx.bytes(2);
      len = new DataView(b.buffer, b.byteOffset, 2).getUint16(0, ctx.le);
    } else {
      const b = ctx.bytes(4);
      len = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, ctx.le);
    }

    if (dataType === 0 && len === 0) break;
    if (dataType !== 1 || len > 1 << 20) throw new ReadStatException(ReadStatError.ERROR_NOTE_IS_TOO_LONG);

    if (ctx.parser.handlers.note && len >= 2 * cfg.chMetadataLen) {
      const buffer = ctx.bytes(len);
      if (latin1(buffer, 0, 4) === "_dta") {
        const metaStr = latin1(buffer, cfg.chMetadataLen, strnlen(buffer, cfg.chMetadataLen, cfg.chMetadataLen));
        const nm = /^note(\d+)/.exec(metaStr);
        if (nm) {
          const note = ctx.conv(buffer, 2 * cfg.chMetadataLen, strnlen(buffer, 2 * cfg.chMetadataLen, len - 2 * cfg.chMetadataLen));
          if (hstatus(ctx.parser.handlers.note(parseInt(nm[1], 10), note, ctx.userCtx)) !== HandlerStatus.OK) {
            throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
          }
        }
      }
    } else {
      ctx.seekCur(len);
    }
    ctx.readTag("</ch>");
  }
}

// ---- strls ----

function interpretStrlVo(ctx: DtaReadCtx, buf: Uint8Array, off: number): { v: number; o: number } {
  const cfg = ctx.cfg;
  const b = buf;
  if (cfg.strlVLen === 2) {
    if (!ctx.le) {
      const v = (b[off] << 8) + b[off + 1];
      const o =
        b[off + 2] * 2 ** 40 + b[off + 3] * 2 ** 32 + b[off + 4] * 2 ** 24 + (b[off + 5] << 16) + (b[off + 6] << 8) + b[off + 7];
      return { v, o };
    } else {
      const v = b[off] + (b[off + 1] << 8);
      const o =
        b[off + 2] + (b[off + 3] << 8) + (b[off + 4] << 16) + b[off + 5] * 2 ** 24 + b[off + 6] * 2 ** 32 + b[off + 7] * 2 ** 40;
      return { v, o };
    }
  } else {
    const dv = new DataView(b.buffer, b.byteOffset + off, 8);
    return { v: dv.getUint32(0, ctx.le), o: dv.getUint32(4, ctx.le) };
  }
}

function readStrls(ctx: DtaReadCtx): void {
  const cfg = ctx.cfg;
  if (!cfg.fileIsXmlish) return;
  ctx.seekSet(ctx.strlsOffset);
  ctx.readTag("<strls>");
  for (;;) {
    const tag = ctx.bytes(3);
    const t = latin1(tag);
    if (t === "GSO") {
      let v: number, o: number, type: number, len: number;
      if (cfg.strlOLen > 4) {
        // 118 header: v(4), o(8), type(1), len(4) = 17
        const h = ctx.bytes(17);
        const dv = new DataView(h.buffer, h.byteOffset, 17);
        v = dv.getUint32(0, ctx.le);
        o = Number(dv.getBigUint64(4, ctx.le));
        type = h[12];
        len = dv.getInt32(13, ctx.le);
      } else {
        // 117 header: v(4), o(4), type(1), len(4) = 13
        const h = ctx.bytes(13);
        const dv = new DataView(h.buffer, h.byteOffset, 13);
        v = dv.getUint32(0, ctx.le);
        o = dv.getUint32(4, ctx.le);
        type = h[8];
        len = dv.getInt32(9, ctx.le);
      }
      const data = ctx.bytes(len);
      if (type === DTA_GSO_TYPE_ASCII) {
        ctx.strls.set(`${o},${v}`, data);
      }
    } else if (t === "</s") {
      ctx.readTag("trls>");
      break;
    } else {
      throw new ReadStatException(ReadStatError.ERROR_PARSE);
    }
  }
}

// ---- data ----

function handleRow(ctx: DtaReadCtx, buf: Uint8Array): void {
  const valueHandler = ctx.parser.handlers.value!;
  let offset = 0;
  for (let j = 0; j < ctx.nvar; j++) {
    const info = dtaTypeInfo(ctx.typlist[j], ctx.cfg);
    const maxLen = info.maxLen;
    const variable = ctx.variables[j]!;

    if (variable.skip) {
      offset += maxLen;
      continue;
    }
    if (offset + maxLen > ctx.recordLen) throw new ReadStatException(ReadStatError.ERROR_PARSE);

    let value: ReadStatValue;
    switch (info.type) {
      case ReadStatType.STRING: {
        if (maxLen === 0) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        const strLen = strnlen(buf, offset, maxLen);
        value = makeStringValue(ctx.conv(buf, offset, strLen));
        break;
      }
      case ReadStatType.STRING_REF: {
        const { v, o } = interpretStrlVo(ctx, buf, offset);
        const data = ctx.strls.get(`${o},${v}`);
        value = makeStringValue(data ? ctx.conv(data) : null);
        break;
      }
      case ReadStatType.INT8:
        value = interpretInt8(ctx, buf, offset);
        break;
      case ReadStatType.INT16:
        value = interpretInt16(ctx, buf, offset);
        break;
      case ReadStatType.INT32:
        value = interpretInt32(ctx, buf, offset);
        break;
      case ReadStatType.FLOAT:
        value = interpretFloat(ctx, buf, offset);
        break;
      case ReadStatType.DOUBLE:
        value = interpretDouble(ctx, buf, offset);
        break;
      default:
        value = new ReadStatValue(info.type);
    }

    if (hstatus(valueHandler(ctx.currentRow, variable, value, ctx.userCtx)) !== HandlerStatus.OK) {
      throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
    }
    offset += maxLen;
  }
}

function handleRows(ctx: DtaReadCtx): void {
  if (ctx.rowOffset) {
    ctx.seekCur(ctx.recordLen * ctx.rowOffset);
  }
  for (let i = 0; i < ctx.rowLimit; i++) {
    const buf = ctx.bytes(ctx.recordLen);
    handleRow(ctx, buf);
    ctx.currentRow++;
  }
  if (ctx.rowLimit < ctx.nobs - ctx.rowOffset) {
    ctx.seekCur(ctx.recordLen * (ctx.nobs - ctx.rowOffset - ctx.rowLimit));
  }
}

function readData(ctx: DtaReadCtx): void {
  if (!ctx.parser.handlers.value) return;
  ctx.seekSet(ctx.dataOffset);
  ctx.readTag("<data>");
  handleRows(ctx);
  ctx.readTag("</data>");
}

function handleValueLabels(ctx: DtaReadCtx): void {
  const cfg = ctx.cfg;
  ctx.seekSet(ctx.valueLabelsOffset);
  ctx.readTag("<value_labels>");
  if (!ctx.parser.handlers.valueLabel) return;
  const io = ctx.io;

  for (;;) {
    let len = 0;
    let n = 0;
    if (cfg.valueLabelTableLenLen === 2) {
      const b = io.read(2);
      if (b.length < 2) break;
      len = new DataView(b.buffer, b.byteOffset, 2).getInt16(0, ctx.le);
      n = Math.floor(len / 8);
    } else {
      // <lbl> tag (noop for legacy)
      try {
        ctx.readTag("<lbl>");
      } catch {
        break;
      }
      const b = io.read(4);
      if (b.length < 4) break;
      len = new DataView(b.buffer, b.byteOffset, 4).getInt32(0, ctx.le);
    }

    const labnameBytes = io.read(cfg.valueLabelTableLabnameLen);
    if (labnameBytes.length < cfg.valueLabelTableLabnameLen) break;
    const labname = ctx.conv(labnameBytes, 0, strnlen(labnameBytes.slice(), 0, cfg.valueLabelTableLabnameLen));

    if (io.seek(cfg.valueLabelTablePaddingLen, ReadStatSeek.CUR) === -1) break;

    const tableBuffer = io.read(len).slice();
    if (tableBuffer.length < len) break;

    if (cfg.valueLabelTableLenLen === 2) {
      for (let i = 0; i < n; i++) {
        const value = new ReadStatValue(ReadStatType.INT32);
        value.num = i;
        const labelLen = strnlen(tableBuffer, 8 * i, 8);
        const label = ctx.conv(tableBuffer, 8 * i, labelLen);
        if (labelLen > 0 && hstatus(ctx.parser.handlers.valueLabel(labname, value, label, ctx.userCtx)) !== HandlerStatus.OK) {
          throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
        }
      }
    } else if (len >= 8) {
      ctx.readTag("</lbl>");
      const dv = new DataView(tableBuffer.buffer, tableBuffer.byteOffset, tableBuffer.byteLength);
      n = dv.getUint32(0, ctx.le);
      const txtlen = dv.getUint32(4, ctx.le);
      if (txtlen > len - 8 || n > Math.floor((len - 8 - txtlen) / 8)) break;

      const offBase = 8;
      const valBase = 8 + 4 * n;
      const txtBase = 8 * n + 8;
      for (let i = 0; i < n; i++) {
        const offI = dv.getUint32(offBase + 4 * i, ctx.le);
        if (offI >= txtlen) throw new ReadStatException(ReadStatError.ERROR_PARSE);
        const value = interpretInt32(ctx, tableBuffer, valBase + 4 * i);
        let maxLabelLen = txtlen - offI;
        if (maxLabelLen > MAX_VALUE_LABEL_LEN) maxLabelLen = MAX_VALUE_LABEL_LEN;
        const labelLen = strnlen(tableBuffer, txtBase + offI, maxLabelLen);
        const label = ctx.conv(tableBuffer, txtBase + offI, labelLen);
        if (hstatus(ctx.parser.handlers.valueLabel(labname, value, label, ctx.userCtx)) !== HandlerStatus.OK) {
          throw new ReadStatException(ReadStatError.ERROR_USER_ABORT);
        }
      }
    }
  }
}

export function parseDta(parser: ReadStatParser, io: IoContext, userCtx: unknown): ReadStatError {
  const ctx = new DtaReadCtx(io, parser, userCtx);
  try {
    const magic = ioReadExact(io, 4);
    const fileSize = io.seek(0, ReadStatSeek.END);
    if (fileSize === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
    io.seek(0, ReadStatSeek.SET);

    let hdr;
    if (latin1(magic) === "<sta") {
      hdr = readXmlishHeader(ctx);
    } else {
      hdr = readLegacyHeader(ctx);
    }

    ctx.cfg = new DtaConfig(hdr.dsFormat, hdr.byteorder, hdr.nvar);
    ctx.le = ctx.cfg.le;
    ctx.xmlish = ctx.cfg.fileIsXmlish;
    ctx.nvar = hdr.nvar;
    ctx.nobs = hdr.nobs;
    ctx.variables = new Array(ctx.nvar).fill(null);
    ctx.variableSkip = new Array(ctx.nvar).fill(false);
    ctx.srcEncoding = parser.inputEncoding ?? (hdr.dsFormat < 118 ? "WINDOWS-1252" : "UTF-8");
    ctx.initialized = true;

    if (parser.rowOffset > 0) ctx.rowOffset = parser.rowOffset;
    let nobsAfterSkipping = ctx.nobs - ctx.rowOffset;
    if (nobsAfterSkipping < 0) {
      nobsAfterSkipping = 0;
      ctx.rowOffset = ctx.nobs;
    }
    ctx.rowLimit = nobsAfterSkipping;
    if (parser.rowLimit > 0 && parser.rowLimit < nobsAfterSkipping) ctx.rowLimit = parser.rowLimit;

    readLabelAndTimestamp(ctx);
    ctx.readTag("</header>");

    if (parser.handlers.metadata) {
      const metadata: ReadStatMetadata = makeEmptyMetadata();
      metadata.rowCount = ctx.rowLimit;
      metadata.varCount = ctx.nvar;
      metadata.fileLabel = ctx.dataLabel;
      metadata.creationTime = ctx.timestamp;
      metadata.modifiedTime = ctx.timestamp;
      metadata.fileFormatVersion = ctx.cfg.dsFormat;
      metadata.is64bit = ctx.cfg.dsFormat >= 118;
      metadata.endianness = ctx.cfg.endianness;
      if (hstatus(parser.handlers.metadata(metadata, userCtx)) !== HandlerStatus.OK) {
        return ReadStatError.ERROR_USER_ABORT;
      }
    }

    readMap(ctx);
    readDescriptors(ctx);

    ctx.recordLen = 0;
    for (let i = 0; i < ctx.nvar; i++) {
      ctx.recordLen += dtaTypeInfo(ctx.typlist[i], ctx.cfg).maxLen;
    }
    if ((ctx.nvar > 0 || ctx.nobs > 0) && ctx.recordLen === 0) {
      return ReadStatError.ERROR_PARSE;
    }

    handleVariables(ctx);
    readExpansionFields(ctx);

    if (!ctx.cfg.fileIsXmlish) {
      ctx.dataOffset = io.tell();
      ctx.valueLabelsOffset = ctx.dataOffset + ctx.recordLen * ctx.nobs;
    }

    readStrls(ctx);
    readData(ctx);
    handleValueLabels(ctx);

    return ReadStatError.OK;
  } catch (e) {
    if (e instanceof ReadStatException) return e.code;
    if (e instanceof DtaTypeError) return e.code;
    if (e instanceof IoReadError) return ReadStatError.ERROR_READ;
    throw e;
  }
}
