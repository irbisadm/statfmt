//
// stata/dta-write.ts — DTA writer (port of readstat_dta_write.c)
//

import { ReadStatError } from "../errors.js";
import { ReadStatType, ReadStatAlignment, readstatTypeClass, ReadStatTypeClass, ReadStatCompress } from "../types.js";
import { Writer, StringRef, latin1Bytes } from "../writer.js";
import { Variable } from "../variable.js";
import { ValueLabel } from "../labelset.js";
import { BinaryWriter } from "../binary.js";
import {
  DtaConfig,
  dtaTypeInfo,
  DTA_LOHI,
  DTA_GSO_TYPE_ASCII,
  DTA_OLD_MAX_INT8,
  DTA_OLD_MAX_INT16,
  DTA_OLD_MAX_INT32,
  DTA_OLD_MISSING_INT8,
  DTA_OLD_MISSING_INT16,
  DTA_OLD_MISSING_INT32,
  DTA_OLD_MISSING_FLOAT,
  DTA_OLD_MISSING_DOUBLE,
  DTA_113_MAX_INT8,
  DTA_113_MAX_INT16,
  DTA_113_MAX_INT32,
  DTA_113_MAX_FLOAT,
  DTA_113_MAX_DOUBLE,
  DTA_113_MISSING_INT8,
  DTA_113_MISSING_INT16,
  DTA_113_MISSING_INT32,
  DTA_113_MISSING_FLOAT,
  DTA_113_MISSING_DOUBLE,
  DTA_113_MISSING_INT8_A,
  DTA_113_MISSING_INT16_A,
  DTA_113_MISSING_INT32_A,
  DTA_113_MISSING_FLOAT_A,
  DTA_113_MISSING_DOUBLE_A,
  DTA_117_TYPE_CODE_INT8,
  DTA_117_TYPE_CODE_INT16,
  DTA_117_TYPE_CODE_INT32,
  DTA_117_TYPE_CODE_FLOAT,
  DTA_117_TYPE_CODE_DOUBLE,
  DTA_117_TYPE_CODE_STRL,
  DTA_111_TYPE_CODE_INT8,
  DTA_111_TYPE_CODE_INT16,
  DTA_111_TYPE_CODE_INT32,
  DTA_111_TYPE_CODE_FLOAT,
  DTA_111_TYPE_CODE_DOUBLE,
  DTA_OLD_TYPE_CODE_INT8,
  DTA_OLD_TYPE_CODE_INT16,
  DTA_OLD_TYPE_CODE_INT32,
  DTA_OLD_TYPE_CODE_FLOAT,
  DTA_OLD_TYPE_CODE_DOUBLE,
} from "./dta.js";
import { dtaFormatTimestamp } from "./dta-parse-timestamp.js";
import { epochToTm } from "../spss/sav-parse-timestamp.js";

const DTA_FILE_VERSION_DEFAULT = 118;
const DTA_OLD_MAX_WIDTH = 128;
const DTA_111_MAX_WIDTH = 244;
const DTA_117_MAX_WIDTH = 2045;
const DTA_OLD_MAX_NAME_LEN = 9;
const DTA_110_MAX_NAME_LEN = 33;
const DTA_118_MAX_NAME_LEN = 129;

const DTA_DEFAULT_DISPLAY_WIDTH_BYTE = 8;
const DTA_DEFAULT_DISPLAY_WIDTH_INT16 = 8;
const DTA_DEFAULT_DISPLAY_WIDTH_INT32 = 12;
const DTA_DEFAULT_DISPLAY_WIDTH_FLOAT = 9;
const DTA_DEFAULT_DISPLAY_WIDTH_DOUBLE = 10;
const DTA_DEFAULT_DISPLAY_WIDTH_STRING = 9;

const utf8 = new TextEncoder();
function enc(s: string): Uint8Array {
  return utf8.encode(s);
}

/** strncpy(dest+off, str, entryLen) semantics: copy min(bytes, entryLen), rest stays 0. */
function fillField(dest: Uint8Array, off: number, entryLen: number, str: string): void {
  const b = enc(str);
  const n = Math.min(b.length, entryLen);
  dest.set(b.subarray(0, n), off);
}

class DtaWriteCtx {
  cfg: DtaConfig;
  nvar: number;
  nobs: number;
  typlist: number[];
  varlist: Uint8Array;
  fmtlist: Uint8Array;
  lbllist: Uint8Array;
  variableLabels: Uint8Array;
  srtlist: Uint8Array;
  recordLen = 0;

  varlistLen: number;
  fmtlistLen: number;
  lbllistLen: number;
  variableLabelsLen: number;

  constructor(version: number, nvar: number, nobs: number) {
    this.cfg = new DtaConfig(version, DTA_LOHI, nvar);
    this.nvar = nvar;
    this.nobs = nobs;
    this.typlist = new Array(nvar).fill(0);
    this.varlistLen = this.cfg.variableNameLen * nvar;
    this.fmtlistLen = this.cfg.fmtlistEntryLen * nvar;
    this.lbllistLen = this.cfg.lbllistEntryLen * nvar;
    this.variableLabelsLen = this.cfg.variableLabelsEntryLen * nvar;
    this.varlist = new Uint8Array(this.varlistLen);
    this.fmtlist = new Uint8Array(this.fmtlistLen);
    this.lbllist = new Uint8Array(this.lbllistLen);
    this.variableLabels = new Uint8Array(this.variableLabelsLen);
    this.srtlist = new Uint8Array(this.cfg.srtlistLen);
  }
}

function writeTag(writer: Writer, ctx: DtaWriteCtx, tag: string): ReadStatError {
  if (!ctx.cfg.fileIsXmlish) return ReadStatError.OK;
  return writer.writeBytes(latin1Bytes(tag));
}

function writeChunk(writer: Writer, ctx: DtaWriteCtx, start: string, bytes: Uint8Array, end: string): ReadStatError {
  let e = writeTag(writer, ctx, start);
  if (e !== ReadStatError.OK) return e;
  e = writer.writeBytes(bytes);
  if (e !== ReadStatError.OK) return e;
  return writeTag(writer, ctx, end);
}

function tagLen(ctx: DtaWriteCtx, tag: string): number {
  return ctx.cfg.fileIsXmlish ? tag.length : 0;
}

// ---- type codes ----

function typecodeForVariable(v: Variable, ctx: DtaWriteCtx): { code: number; error: ReadStatError } {
  const maxLen = v.storageWidth;
  const ver = ctx.cfg.typlistVersion;
  if (ver === 111) {
    switch (v.type) {
      case ReadStatType.INT8: return { code: DTA_111_TYPE_CODE_INT8, error: ReadStatError.OK };
      case ReadStatType.INT16: return { code: DTA_111_TYPE_CODE_INT16, error: ReadStatError.OK };
      case ReadStatType.INT32: return { code: DTA_111_TYPE_CODE_INT32, error: ReadStatError.OK };
      case ReadStatType.FLOAT: return { code: DTA_111_TYPE_CODE_FLOAT, error: ReadStatError.OK };
      case ReadStatType.DOUBLE: return { code: DTA_111_TYPE_CODE_DOUBLE, error: ReadStatError.OK };
      case ReadStatType.STRING: return { code: maxLen, error: ReadStatError.OK };
      case ReadStatType.STRING_REF: return { code: 0, error: ReadStatError.ERROR_STRING_REFS_NOT_SUPPORTED };
    }
  } else if (ver === 117) {
    switch (v.type) {
      case ReadStatType.INT8: return { code: DTA_117_TYPE_CODE_INT8, error: ReadStatError.OK };
      case ReadStatType.INT16: return { code: DTA_117_TYPE_CODE_INT16, error: ReadStatError.OK };
      case ReadStatType.INT32: return { code: DTA_117_TYPE_CODE_INT32, error: ReadStatError.OK };
      case ReadStatType.FLOAT: return { code: DTA_117_TYPE_CODE_FLOAT, error: ReadStatError.OK };
      case ReadStatType.DOUBLE: return { code: DTA_117_TYPE_CODE_DOUBLE, error: ReadStatError.OK };
      case ReadStatType.STRING: return { code: maxLen, error: ReadStatError.OK };
      case ReadStatType.STRING_REF: return { code: DTA_117_TYPE_CODE_STRL, error: ReadStatError.OK };
    }
  } else {
    switch (v.type) {
      case ReadStatType.INT8: return { code: DTA_OLD_TYPE_CODE_INT8, error: ReadStatError.OK };
      case ReadStatType.INT16: return { code: DTA_OLD_TYPE_CODE_INT16, error: ReadStatError.OK };
      case ReadStatType.INT32: return { code: DTA_OLD_TYPE_CODE_INT32, error: ReadStatError.OK };
      case ReadStatType.FLOAT: return { code: DTA_OLD_TYPE_CODE_FLOAT, error: ReadStatError.OK };
      case ReadStatType.DOUBLE: return { code: DTA_OLD_TYPE_CODE_DOUBLE, error: ReadStatError.OK };
      case ReadStatType.STRING: return { code: maxLen + 0x7f, error: ReadStatError.OK };
      case ReadStatType.STRING_REF: return { code: 0, error: ReadStatError.ERROR_STRING_REFS_NOT_SUPPORTED };
    }
  }
  return { code: 0, error: ReadStatError.ERROR_PARSE };
}

// ---- variable width ----

function numericVariableWidth(type: ReadStatType): number {
  switch (type) {
    case ReadStatType.DOUBLE: return 8;
    case ReadStatType.FLOAT: return 4;
    case ReadStatType.INT32: return 4;
    case ReadStatType.INT16: return 2;
    case ReadStatType.INT8: return 1;
    default: return 0;
  }
}

function variableWidth(version: number, type: ReadStatType, userWidth: number): number {
  if (type === ReadStatType.STRING) {
    const max = version >= 117 ? DTA_117_MAX_WIDTH : version >= 111 ? DTA_111_MAX_WIDTH : DTA_OLD_MAX_WIDTH;
    if (userWidth > max || userWidth === 0) userWidth = max;
    return userWidth;
  }
  if (type === ReadStatType.STRING_REF && version >= 117) return 8;
  return numericVariableWidth(type);
}

// ---- name validation ----

const RESERVED = new Set([
  "_all", "_b", "byte", "_coef", "_cons", "double", "float", "if", "in", "int",
  "long", "_n", "_N", "_pi", "_pred", "_rc", "_skip", "strL", "using", "with",
]);

function validateNameChars(name: string, unicode: boolean): ReadStatError {
  for (let j = 0; j < name.length; j++) {
    const c = name[j];
    const code = name.charCodeAt(j);
    if ((code < 0x80 || !unicode) && c !== "_" && !(c >= "a" && c <= "z") && !(c >= "A" && c <= "Z") && !(c >= "0" && c <= "9")) {
      return ReadStatError.ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER;
    }
  }
  const first = name[0];
  const firstCode = name.charCodeAt(0);
  if ((firstCode < 0x80 || !unicode) && first !== "_" && !(first >= "a" && first <= "z") && !(first >= "A" && first <= "Z")) {
    return ReadStatError.ERROR_NAME_BEGINS_WITH_ILLEGAL_CHARACTER;
  }
  return ReadStatError.OK;
}

function validateName(name: string, unicode: boolean, maxLen: number): ReadStatError {
  if (enc(name).length > maxLen) return ReadStatError.ERROR_NAME_IS_TOO_LONG;
  if (name.length === 0) return ReadStatError.ERROR_NAME_IS_ZERO_LENGTH;
  const e = validateNameChars(name, unicode);
  if (e !== ReadStatError.OK) return e;
  if (RESERVED.has(name)) return ReadStatError.ERROR_NAME_IS_RESERVED_WORD;
  if (/^str\d+$/.test(name)) return ReadStatError.ERROR_NAME_IS_RESERVED_WORD;
  return ReadStatError.OK;
}

// ---- emit sections ----

function emitHeaderDataLabel(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  let e = writeTag(writer, ctx, "<label>");
  if (e !== ReadStatError.OK) return e;
  const cfg = ctx.cfg;
  if (cfg.dataLabelLenLen) {
    const labelBytes = enc(writer.fileLabel);
    if (cfg.dataLabelLenLen === 1) {
      e = writer.writeBytes(new Uint8Array([labelBytes.length & 0xff]));
    } else {
      const b = new BinaryWriter(true, 2);
      b.u16(labelBytes.length);
      e = writer.writeBytes(b.finish());
    }
    if (e !== ReadStatError.OK) return e;
    e = writer.writeBytes(labelBytes);
    if (e !== ReadStatError.OK) return e;
  } else {
    const buf = new Uint8Array(cfg.dataLabelLen);
    fillField(buf, 0, cfg.dataLabelLen, writer.fileLabel);
    e = writer.writeBytes(buf);
    if (e !== ReadStatError.OK) return e;
  }
  return writeTag(writer, ctx, "</label>");
}

function emitHeaderTimestamp(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  const cfg = ctx.cfg;
  if (!cfg.timestampLen) return ReadStatError.OK;
  const tm = epochToTm(writer.timestamp);
  // localtime equivalent — use local getters to match C localtime()
  const d = new Date(writer.timestamp * 1000);
  tm.tm_mday = d.getDate();
  tm.tm_mon = d.getMonth();
  tm.tm_year = d.getFullYear() - 1900;
  tm.tm_hour = d.getHours();
  tm.tm_min = d.getMinutes();
  const tsStr = dtaFormatTimestamp(tm); // "DD Mon YYYY HH:MM" (17 chars)
  const tsBytes = latin1Bytes(tsStr);

  if (cfg.fileIsXmlish) {
    let e = writeTag(writer, ctx, "<timestamp>");
    if (e !== ReadStatError.OK) return e;
    e = writer.writeBytes(new Uint8Array([tsBytes.length & 0xff]));
    if (e !== ReadStatError.OK) return e;
    e = writer.writeBytes(tsBytes);
    if (e !== ReadStatError.OK) return e;
    return writeTag(writer, ctx, "</timestamp>");
  }
  const buf = new Uint8Array(cfg.timestampLen);
  buf.set(tsBytes.subarray(0, Math.min(tsBytes.length, cfg.timestampLen)));
  return writer.writeBytes(buf);
}

function emitTyplist(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  let e = writeTag(writer, ctx, "<variable_types>");
  if (e !== ReadStatError.OK) return e;
  for (let i = 0; i < ctx.nvar; i++) {
    const tc = typecodeForVariable(writer.variables[i], ctx);
    if (tc.error !== ReadStatError.OK) return tc.error;
    ctx.typlist[i] = tc.code;
  }
  const b = new BinaryWriter(true, ctx.nvar * ctx.cfg.typlistEntryLen);
  for (let i = 0; i < ctx.nvar; i++) {
    if (ctx.cfg.typlistEntryLen === 1) b.u8(ctx.typlist[i]);
    else b.u16(ctx.typlist[i]);
  }
  e = writer.writeBytes(b.finish());
  if (e !== ReadStatError.OK) return e;
  return writeTag(writer, ctx, "</variable_types>");
}

function emitVarlist(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  for (let i = 0; i < ctx.nvar; i++) {
    fillField(ctx.varlist, ctx.cfg.variableNameLen * i, ctx.cfg.variableNameLen, writer.variables[i].name);
  }
  return writeChunk(writer, ctx, "<varnames>", ctx.varlist, "</varnames>");
}

function emitSrtlist(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  ctx.srtlist.fill(0);
  return writeChunk(writer, ctx, "<sortlist>", ctx.srtlist, "</sortlist>");
}

function emitFmtlist(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  for (let i = 0; i < ctx.nvar; i++) {
    const v = writer.variables[i];
    if (v.format && v.format[0]) {
      fillField(ctx.fmtlist, ctx.cfg.fmtlistEntryLen * i, ctx.cfg.fmtlistEntryLen, v.format);
    } else {
      let formatLetter = "g";
      let displayWidth = v.displayWidth;
      if (readstatTypeClass(v.type) === ReadStatTypeClass.STRING) formatLetter = "s";
      if (!displayWidth) {
        switch (v.type) {
          case ReadStatType.INT8: displayWidth = DTA_DEFAULT_DISPLAY_WIDTH_BYTE; break;
          case ReadStatType.INT16: displayWidth = DTA_DEFAULT_DISPLAY_WIDTH_INT16; break;
          case ReadStatType.INT32: displayWidth = DTA_DEFAULT_DISPLAY_WIDTH_INT32; break;
          case ReadStatType.FLOAT: displayWidth = DTA_DEFAULT_DISPLAY_WIDTH_FLOAT; break;
          case ReadStatType.DOUBLE: displayWidth = DTA_DEFAULT_DISPLAY_WIDTH_DOUBLE; break;
          default: displayWidth = DTA_DEFAULT_DISPLAY_WIDTH_STRING; break;
        }
      }
      const dash = v.alignment === ReadStatAlignment.LEFT ? "-" : "";
      const format = formatLetter === "g" ? `%${dash}${displayWidth}.0g` : `%${dash}${displayWidth}s`;
      fillField(ctx.fmtlist, ctx.cfg.fmtlistEntryLen * i, ctx.cfg.fmtlistEntryLen, format);
    }
  }
  return writeChunk(writer, ctx, "<formats>", ctx.fmtlist, "</formats>");
}

function emitLbllist(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  for (let i = 0; i < ctx.nvar; i++) {
    const v = writer.variables[i];
    if (v.labelSet) {
      fillField(ctx.lbllist, ctx.cfg.lbllistEntryLen * i, ctx.cfg.lbllistEntryLen, v.labelSet.name);
    }
  }
  return writeChunk(writer, ctx, "<value_label_names>", ctx.lbllist, "</value_label_names>");
}

function emitVariableLabels(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  for (let i = 0; i < ctx.nvar; i++) {
    fillField(ctx.variableLabels, ctx.cfg.variableLabelsEntryLen * i, ctx.cfg.variableLabelsEntryLen, writer.variables[i].label);
  }
  return writeChunk(writer, ctx, "<variable_labels>", ctx.variableLabels, "</variable_labels>");
}

function emitCharacteristics(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  const cfg = ctx.cfg;
  if (cfg.expansionLenLen === 0) return ReadStatError.OK;
  let e = writeTag(writer, ctx, "<characteristics>");
  if (e !== ReadStatError.OK) return e;

  for (let i = 0; i < writer.notes.length; i++) {
    if (cfg.fileIsXmlish) e = writeTag(writer, ctx, "<ch>");
    else e = writer.writeBytes(new Uint8Array([1]));
    if (e !== ReadStatError.OK) return e;

    const noteBytes = enc(writer.notes[i]);
    const len = noteBytes.length;
    const total = 2 * cfg.chMetadataLen + len + 1;
    if (cfg.expansionLenLen === 2) {
      const b = new BinaryWriter(true, 2);
      b.i16(total);
      e = writer.writeBytes(b.finish());
    } else {
      const b = new BinaryWriter(true, 4);
      b.i32(total);
      e = writer.writeBytes(b.finish());
    }
    if (e !== ReadStatError.OK) return e;

    const meta1 = new Uint8Array(cfg.chMetadataLen);
    fillField(meta1, 0, cfg.chMetadataLen, "_dta");
    e = writer.writeBytes(meta1);
    if (e !== ReadStatError.OK) return e;

    const meta2 = new Uint8Array(cfg.chMetadataLen);
    fillField(meta2, 0, cfg.chMetadataLen, `note${i + 1}`);
    e = writer.writeBytes(meta2);
    if (e !== ReadStatError.OK) return e;

    const noteBuf = new Uint8Array(len + 1);
    noteBuf.set(noteBytes);
    e = writer.writeBytes(noteBuf);
    if (e !== ReadStatError.OK) return e;

    e = writeTag(writer, ctx, "</ch>");
    if (e !== ReadStatError.OK) return e;
  }

  if (cfg.fileIsXmlish) return writeTag(writer, ctx, "</characteristics>");
  return writer.writeZeros(1 + cfg.expansionLenLen);
}

function emitStrls(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  if (!ctx.cfg.fileIsXmlish) return ReadStatError.OK;
  let e = writer.writeBytes(latin1Bytes("<strls>"));
  if (e !== ReadStatError.OK) return e;
  for (const ref of writer.stringRefs) {
    e = writer.writeBytes(latin1Bytes("GSO"));
    if (e !== ReadStatError.OK) return e;
    const b = new BinaryWriter(true, 17);
    if (ctx.cfg.strlOLen > 4) {
      b.u32(ref.firstV).u64(BigInt(ref.firstO)).u8(DTA_GSO_TYPE_ASCII).i32(ref.len);
    } else {
      b.u32(ref.firstV).u32(ref.firstO).u8(DTA_GSO_TYPE_ASCII).i32(ref.len);
    }
    e = writer.writeBytes(b.finish());
    if (e !== ReadStatError.OK) return e;
    e = writer.writeBytes(ref.data);
    if (e !== ReadStatError.OK) return e;
  }
  return writer.writeBytes(latin1Bytes("</strls>"));
}

function compareValueLabels(a: ValueLabel, b: ValueLabel): number {
  if (a.tag) {
    if (b.tag) return a.tag.charCodeAt(0) - b.tag.charCodeAt(0);
    return 1;
  }
  if (b.tag) return -1;
  return a.int32Key - b.int32Key;
}

function oldEmitValueLabels(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  const cfg = ctx.cfg;
  for (const ls of writer.labelSets) {
    let maxValue = 0;
    for (const vl of ls.valueLabels) {
      if (vl.tag) return ReadStatError.ERROR_TAGGED_VALUES_NOT_SUPPORTED;
      if (vl.int32Key < 0 || vl.int32Key > 1024) return ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE;
      if (vl.int32Key > maxValue) maxValue = vl.int32Key;
    }
    const tableLen = 8 * (maxValue + 1);
    const hdr = new BinaryWriter(true, 2);
    hdr.i16(tableLen);
    let e = writer.writeBytes(hdr.finish());
    if (e !== ReadStatError.OK) return e;

    const labname = new Uint8Array(cfg.valueLabelTableLabnameLen + cfg.valueLabelTablePaddingLen);
    fillField(labname, 0, cfg.valueLabelTableLabnameLen, ls.name);
    e = writer.writeBytes(labname);
    if (e !== ReadStatError.OK) return e;

    const labelBuffer = new Uint8Array(tableLen);
    for (const vl of ls.valueLabels) {
      const lb = enc(vl.label);
      labelBuffer.set(lb.subarray(0, Math.min(lb.length, 8)), 8 * vl.int32Key);
    }
    e = writer.writeBytes(labelBuffer);
    if (e !== ReadStatError.OK) return e;
  }
  return ReadStatError.OK;
}

function emitValueLabels(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  const cfg = ctx.cfg;
  if (cfg.valueLabelTableLenLen === 2) return oldEmitValueLabels(writer, ctx);

  let e = writeTag(writer, ctx, "<value_labels>");
  if (e !== ReadStatError.OK) return e;

  for (const ls of writer.labelSets) {
    const n = ls.valueLabels.length;
    let txtlen = 0;
    const labelBytesList = ls.valueLabels.map((vl) => enc(vl.label));
    for (const lb of labelBytesList) txtlen += lb.length + 1;

    e = writeTag(writer, ctx, "<lbl>");
    if (e !== ReadStatError.OK) return e;

    const tableLen = 8 + 8 * n + txtlen;
    const tlBuf = new BinaryWriter(true, 4);
    tlBuf.i32(tableLen);
    e = writer.writeBytes(tlBuf.finish());
    if (e !== ReadStatError.OK) return e;

    const labname = new Uint8Array(cfg.valueLabelTableLabnameLen + cfg.valueLabelTablePaddingLen);
    fillField(labname, 0, cfg.valueLabelTableLabnameLen, ls.name);
    e = writer.writeBytes(labname);
    if (e !== ReadStatError.OK) return e;

    if (txtlen === 0) {
      const z = new BinaryWriter(true, 8);
      z.i32(0).i32(0);
      e = writer.writeBytes(z.finish());
      if (e !== ReadStatError.OK) return e;
      e = writeTag(writer, ctx, "</lbl>");
      if (e !== ReadStatError.OK) return e;
      continue;
    }

    // sort labels (tag-aware)
    const order = ls.valueLabels.map((vl, idx) => ({ vl, lb: labelBytesList[idx] }));
    order.sort((x, y) => compareValueLabels(x.vl, y.vl));

    const off = new Int32Array(n);
    const val = new Int32Array(n);
    const txt = new Uint8Array(txtlen);
    let offset = 0;
    for (let j = 0; j < n; j++) {
      const { vl, lb } = order[j];
      off[j] = offset;
      if (vl.tag) {
        if (writer.version < 113) return ReadStatError.ERROR_TAGGED_VALUES_NOT_SUPPORTED;
        val[j] = DTA_113_MISSING_INT32_A + (vl.tag.charCodeAt(0) - 0x61);
      } else {
        val[j] = vl.int32Key;
      }
      txt.set(lb, offset);
      offset += lb.length;
      txt[offset++] = 0;
    }

    const body = new BinaryWriter(true, 8 + 8 * n + txtlen);
    body.i32(n).i32(txtlen);
    for (let j = 0; j < n; j++) body.i32(off[j]);
    for (let j = 0; j < n; j++) body.i32(val[j]);
    body.bytes(txt);
    e = writer.writeBytes(body.finish());
    if (e !== ReadStatError.OK) return e;

    e = writeTag(writer, ctx, "</lbl>");
    if (e !== ReadStatError.OK) return e;
  }

  return writeTag(writer, ctx, "</value_labels>");
}

// ---- map (needs sizes precomputed) ----

function measureTag(ctx: DtaWriteCtx, tag: string): number {
  return tagLen(ctx, tag);
}

function measureMap(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<map>") + 14 * 8 + measureTag(ctx, "</map>");
}
function measureTyplist(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<variable_types>") + ctx.cfg.typlistEntryLen * ctx.nvar + measureTag(ctx, "</variable_types>");
}
function measureVarlist(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<varnames>") + ctx.varlistLen + measureTag(ctx, "</varnames>");
}
function measureSrtlist(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<sortlist>") + ctx.cfg.srtlistLen + measureTag(ctx, "</sortlist>");
}
function measureFmtlist(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<formats>") + ctx.fmtlistLen + measureTag(ctx, "</formats>");
}
function measureLbllist(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<value_label_names>") + ctx.lbllistLen + measureTag(ctx, "</value_label_names>");
}
function measureVariableLabels(ctx: DtaWriteCtx): number {
  return measureTag(ctx, "<variable_labels>") + ctx.variableLabelsLen + measureTag(ctx, "</variable_labels>");
}
function measureCharacteristics(writer: Writer, ctx: DtaWriteCtx): number {
  let chLen = 0;
  for (const note of writer.notes) {
    chLen += measureTag(ctx, "<ch>") + ctx.cfg.expansionLenLen + 2 * ctx.cfg.chMetadataLen + enc(note).length + 1 + measureTag(ctx, "</ch>");
  }
  return measureTag(ctx, "<characteristics>") + chLen + measureTag(ctx, "</characteristics>");
}
function measureData(writer: Writer, ctx: DtaWriteCtx): number {
  ctx.recordLen = 0;
  for (let i = 0; i < ctx.nvar; i++) {
    const tc = typecodeForVariable(writer.variables[i], ctx);
    const info = dtaTypeInfo(tc.code, ctx.cfg);
    ctx.recordLen += info.maxLen;
  }
  return measureTag(ctx, "<data>") + ctx.recordLen * ctx.nobs + measureTag(ctx, "</data>");
}
function measureStrls(writer: Writer, ctx: DtaWriteCtx): number {
  let len = 0;
  for (const ref of writer.stringRefs) {
    len += 3 + (ctx.cfg.strlOLen > 4 ? 17 : 13) + ref.len;
  }
  return measureTag(ctx, "<strls>") + len + measureTag(ctx, "</strls>");
}
function measureValueLabels(writer: Writer, ctx: DtaWriteCtx): number {
  let len = measureTag(ctx, "<value_labels>");
  for (const ls of writer.labelSets) {
    const n = ls.valueLabels.length;
    let txtlen = 0;
    for (const vl of ls.valueLabels) txtlen += enc(vl.label).length + 1;
    len += measureTag(ctx, "<lbl>") + 4 + ctx.cfg.valueLabelTableLabnameLen + ctx.cfg.valueLabelTablePaddingLen + 8 + 8 * n + txtlen + measureTag(ctx, "</lbl>");
  }
  return len + measureTag(ctx, "</value_labels>");
}

function emitMap(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  if (!ctx.cfg.fileIsXmlish) return ReadStatError.OK;
  const map = new Array<number>(14);
  map[0] = 0;
  map[1] = writer.bytesWritten;
  map[2] = map[1] + measureMap(ctx);
  map[3] = map[2] + measureTyplist(ctx);
  map[4] = map[3] + measureVarlist(ctx);
  map[5] = map[4] + measureSrtlist(ctx);
  map[6] = map[5] + measureFmtlist(ctx);
  map[7] = map[6] + measureLbllist(ctx);
  map[8] = map[7] + measureVariableLabels(ctx);
  map[9] = map[8] + measureCharacteristics(writer, ctx);
  map[10] = map[9] + measureData(writer, ctx);
  map[11] = map[10] + measureStrls(writer, ctx);
  map[12] = map[11] + measureValueLabels(writer, ctx);
  map[13] = map[12] + measureTag(ctx, "</stata_dta>");
  const b = new BinaryWriter(true, 14 * 8);
  for (let i = 0; i < 14; i++) b.u64(BigInt(map[i]));
  return writeChunk(writer, ctx, "<map>", b.finish(), "</map>");
}

// ---- header + descriptors ----

function emitXmlishHeader(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  let e = writeTag(writer, ctx, "<stata_dta>");
  if (e !== ReadStatError.OK) return e;
  e = writeTag(writer, ctx, "<header>");
  if (e !== ReadStatError.OK) return e;
  e = writer.writeBytes(latin1Bytes(`<release>${writer.version}</release>`));
  if (e !== ReadStatError.OK) return e;
  e = writeChunk(writer, ctx, "<byteorder>", latin1Bytes("LSF"), "</byteorder>");
  if (e !== ReadStatError.OK) return e;

  if (writer.version >= 119) {
    const b = new BinaryWriter(true, 4);
    b.u32(writer.variables.length);
    e = writeChunk(writer, ctx, "<K>", b.finish(), "</K>");
  } else {
    const b = new BinaryWriter(true, 2);
    b.u16(writer.variables.length);
    e = writeChunk(writer, ctx, "<K>", b.finish(), "</K>");
  }
  if (e !== ReadStatError.OK) return e;

  if (writer.version >= 118) {
    const b = new BinaryWriter(true, 8);
    b.u64(BigInt(writer.rowCount));
    e = writeChunk(writer, ctx, "<N>", b.finish(), "</N>");
  } else {
    const b = new BinaryWriter(true, 4);
    b.u32(writer.rowCount);
    e = writeChunk(writer, ctx, "<N>", b.finish(), "</N>");
  }
  if (e !== ReadStatError.OK) return e;

  e = emitHeaderDataLabel(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitHeaderTimestamp(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  return writeTag(writer, ctx, "</header>");
}

function emitHeader(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  if (ctx.cfg.fileIsXmlish) return emitXmlishHeader(writer, ctx);
  if (writer.variables.length > 32767) return ReadStatError.ERROR_TOO_MANY_COLUMNS;
  const b = new BinaryWriter(true, 8);
  b.u8(writer.version).u8(DTA_LOHI).u8(0x01).u8(0x00).u16(writer.variables.length).u32(writer.rowCount);
  let e = writer.writeBytes(b.finish());
  if (e !== ReadStatError.OK) return e;
  e = emitHeaderDataLabel(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  emitHeaderTimestamp(writer, ctx);
  return ReadStatError.OK; // C returns OK unconditionally here
}

function emitDescriptors(writer: Writer, ctx: DtaWriteCtx): ReadStatError {
  let e = emitTyplist(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitVarlist(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitSrtlist(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitFmtlist(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  return emitLbllist(writer, ctx);
}

// ---- value writers ----

function w8(writer: Writer, offset: number, value: number): void {
  new DataView(writer.row.buffer, writer.row.byteOffset).setInt8(offset, value);
}
function w16(writer: Writer, offset: number, value: number): void {
  new DataView(writer.row.buffer, writer.row.byteOffset).setInt16(offset, value, true);
}
function w32(writer: Writer, offset: number, value: number): void {
  new DataView(writer.row.buffer, writer.row.byteOffset).setInt32(offset, value | 0, true);
}
function w64(writer: Writer, offset: number, value: bigint): void {
  new DataView(writer.row.buffer, writer.row.byteOffset).setBigInt64(offset, value, true);
}
function wf32(writer: Writer, offset: number, value: number): void {
  new DataView(writer.row.buffer, writer.row.byteOffset).setFloat32(offset, value, true);
}
function wf64(writer: Writer, offset: number, value: number): void {
  new DataView(writer.row.buffer, writer.row.byteOffset).setFloat64(offset, value, true);
}

function writeMissingNumeric113(writer: Writer, offset: number, v: Variable): ReadStatError {
  switch (v.type) {
    case ReadStatType.INT8: w8(writer, offset, DTA_113_MISSING_INT8); break;
    case ReadStatType.INT16: w16(writer, offset, DTA_113_MISSING_INT16); break;
    case ReadStatType.INT32: w32(writer, offset, DTA_113_MISSING_INT32); break;
    case ReadStatType.FLOAT: w32(writer, offset, DTA_113_MISSING_FLOAT); break;
    case ReadStatType.DOUBLE: w64(writer, offset, DTA_113_MISSING_DOUBLE); break;
  }
  return ReadStatError.OK;
}
function writeMissingNumericOld(writer: Writer, offset: number, v: Variable): ReadStatError {
  switch (v.type) {
    case ReadStatType.INT8: w8(writer, offset, DTA_OLD_MISSING_INT8); break;
    case ReadStatType.INT16: w16(writer, offset, DTA_OLD_MISSING_INT16); break;
    case ReadStatType.INT32: w32(writer, offset, DTA_OLD_MISSING_INT32); break;
    case ReadStatType.FLOAT: w32(writer, offset, DTA_OLD_MISSING_FLOAT); break;
    case ReadStatType.DOUBLE: w64(writer, offset, DTA_OLD_MISSING_DOUBLE); break;
  }
  return ReadStatError.OK;
}

const DTA_113_MAX_FLOAT_F = new DataView((() => { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, DTA_113_MAX_FLOAT, true); return b; })()).getFloat32(0, true);
const DTA_113_MAX_DOUBLE_D = new DataView((() => { const b = new ArrayBuffer(8); new DataView(b).setBigInt64(0, DTA_113_MAX_DOUBLE, true); return b; })()).getFloat64(0, true);

function writeString(writer: Writer, offset: number, v: Variable, value: string): ReadStatError {
  const maxLen = v.storageWidth;
  writer.row.fill(0, offset, offset + maxLen);
  if (value && value.length > 0) {
    const b = enc(value);
    if (b.length > maxLen) return ReadStatError.ERROR_STRING_VALUE_IS_TOO_LONG;
    writer.row.set(b.subarray(0, Math.min(b.length, maxLen)), offset);
  }
  return ReadStatError.OK;
}

function writeStringRef118(writer: Writer, offset: number, ref: StringRef): ReadStatError {
  if (!ref) return ReadStatError.ERROR_STRING_REF_IS_REQUIRED;
  w16(writer, offset, ref.firstV);
  // write low 6 bytes of firstO, little-endian
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigInt64(0, BigInt(ref.firstO), true);
  for (let k = 0; k < 6; k++) writer.row[offset + 2 + k] = dv.getUint8(k);
  return ReadStatError.OK;
}
function writeStringRef117(writer: Writer, offset: number, ref: StringRef): ReadStatError {
  if (!ref) return ReadStatError.ERROR_STRING_REF_IS_REQUIRED;
  w32(writer, offset, ref.firstV);
  w32(writer, offset + 4, ref.firstO);
  return ReadStatError.OK;
}

function writeMissingTagged113(writer: Writer, offset: number, v: Variable, tag: string): ReadStatError {
  const t = tag.charCodeAt(0);
  if (t < 0x61 || t > 0x7a) return ReadStatError.ERROR_TAGGED_VALUE_IS_OUT_OF_RANGE;
  const d = t - 0x61;
  switch (v.type) {
    case ReadStatType.INT8: w8(writer, offset, DTA_113_MISSING_INT8_A + d); break;
    case ReadStatType.INT16: w16(writer, offset, DTA_113_MISSING_INT16_A + d); break;
    case ReadStatType.INT32: w32(writer, offset, DTA_113_MISSING_INT32_A + d); break;
    case ReadStatType.FLOAT: w32(writer, offset, DTA_113_MISSING_FLOAT_A + (d << 11)); break;
    case ReadStatType.DOUBLE: w64(writer, offset, DTA_113_MISSING_DOUBLE_A + (BigInt(d) << 40n)); break;
    default: return ReadStatError.ERROR_TAGGED_VALUES_NOT_SUPPORTED;
  }
  return ReadStatError.OK;
}

// ---- lifecycle ----

function dtaBeginData(writer: Writer): ReadStatError {
  if (!writer.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
  let ctx: DtaWriteCtx;
  try {
    ctx = new DtaWriteCtx(writer.version, writer.variables.length, writer.rowCount);
  } catch {
    return ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION;
  }
  writer.moduleCtx = ctx;

  let e = emitHeader(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitMap(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitDescriptors(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitVariableLabels(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitCharacteristics(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  return writeTag(writer, ctx, "<data>");
}

function dtaEndData(writer: Writer): ReadStatError {
  if (!writer.initialized) return ReadStatError.ERROR_WRITER_NOT_INITIALIZED;
  const ctx = writer.moduleCtx as DtaWriteCtx;
  let e = writeTag(writer, ctx, "</data>");
  if (e !== ReadStatError.OK) return e;
  e = emitStrls(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  e = emitValueLabels(writer, ctx);
  if (e !== ReadStatError.OK) return e;
  return writeTag(writer, ctx, "</stata_dta>");
}

function metadataOk(writer: Writer): ReadStatError {
  if (writer.compression !== ReadStatCompress.NONE) return ReadStatError.ERROR_UNSUPPORTED_COMPRESSION;
  if (writer.version > 119 || writer.version < 104) return ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION;
  return ReadStatError.OK;
}

export function beginWritingDta(writer: Writer, userCtx: unknown, rowCount: number): ReadStatError {
  if (writer.version === 0) writer.version = DTA_FILE_VERSION_DEFAULT;
  const version = writer.version;

  writer.callbacks.metadataOk = metadataOk;
  writer.callbacks.variableWidth = (type, userWidth) => variableWidth(version, type, userWidth);

  if (version >= 118) writer.callbacks.variableOk = (v) => validateName(v.name, true, DTA_118_MAX_NAME_LEN);
  else if (version >= 110) writer.callbacks.variableOk = (v) => validateName(v.name, false, DTA_110_MAX_NAME_LEN);
  else writer.callbacks.variableOk = (v) => validateName(v.name, false, DTA_OLD_MAX_NAME_LEN);

  if (version >= 118) writer.callbacks.writeStringRef = (w, off, _v, ref) => writeStringRef118(w, off, ref);
  else if (version === 117) writer.callbacks.writeStringRef = (w, off, _v, ref) => writeStringRef117(w, off, ref);

  if (version >= 113) {
    writer.callbacks.writeInt8 = (w, off, _v, value) =>
      value > DTA_113_MAX_INT8 ? ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE : (w8(w, off, value), ReadStatError.OK);
    writer.callbacks.writeInt16 = (w, off, _v, value) =>
      value > DTA_113_MAX_INT16 ? ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE : (w16(w, off, value), ReadStatError.OK);
    writer.callbacks.writeInt32 = (w, off, _v, value) =>
      value > DTA_113_MAX_INT32 ? ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE : (w32(w, off, value), ReadStatError.OK);
    writer.callbacks.writeMissingNumber = (w, off, v) => writeMissingNumeric113(w, off, v);
    writer.callbacks.writeMissingTagged = (w, off, v, tag) => writeMissingTagged113(w, off, v, tag);
  } else {
    writer.callbacks.writeInt8 = (w, off, _v, value) =>
      value > DTA_OLD_MAX_INT8 ? ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE : (w8(w, off, value), ReadStatError.OK);
    writer.callbacks.writeInt16 = (w, off, _v, value) =>
      value > DTA_OLD_MAX_INT16 ? ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE : (w16(w, off, value), ReadStatError.OK);
    writer.callbacks.writeInt32 = (w, off, _v, value) =>
      value > DTA_OLD_MAX_INT32 ? ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE : (w32(w, off, value), ReadStatError.OK);
    writer.callbacks.writeMissingNumber = (w, off, v) => writeMissingNumericOld(w, off, v);
  }

  writer.callbacks.writeFloat = (w, off, v, value) => {
    if (value > DTA_113_MAX_FLOAT_F) return ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE;
    if (Number.isNaN(value)) return writeMissingNumeric113(w, off, v);
    wf32(w, off, value);
    return ReadStatError.OK;
  };
  writer.callbacks.writeDouble = (w, off, v, value) => {
    if (value > DTA_113_MAX_DOUBLE_D) return ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE;
    if (Number.isNaN(value)) return writeMissingNumeric113(w, off, v);
    wf64(w, off, value);
    return ReadStatError.OK;
  };
  writer.callbacks.writeString = (w, off, v, value) => writeString(w, off, v, value);
  writer.callbacks.writeMissingString = (w, off, v) => writeString(w, off, v, "");

  writer.callbacks.beginData = dtaBeginData;
  writer.callbacks.endData = dtaEndData;

  return writer.beginWritingFile(userCtx, rowCount);
}
