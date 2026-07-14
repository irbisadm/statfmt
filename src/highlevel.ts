//
// highlevel.ts — ergonomic read/write API on top of the streaming parser/writer
//

import { ReadStatParser } from "./parser.js";
import { BufferIoContext, IoContext } from "./io.js";
import { ReadStatError, ReadStatException, readstatErrorMessage } from "./errors.js";
import {
  ReadStatType,
  ReadStatMeasure,
  ReadStatAlignment,
  ReadStatCompress,
  ReadStatMetadata,
} from "./types.js";
import { Variable } from "./variable.js";
import { Writer } from "./writer.js";
import { LabelSet } from "./labelset.js";
import { parseSav } from "./spss/sav-read.js";
import { beginWritingSav } from "./spss/sav-write.js";
import { parsePor } from "./spss/por-read.js";
import { beginWritingPor } from "./spss/por-write.js";
import { parseDta } from "./stata/dta-read.js";
import { beginWritingDta } from "./stata/dta-write.js";
import { parseXport } from "./sas/xport-read.js";
import { beginWritingXport } from "./sas/xport-write.js";
import { parseSas7bdat } from "./sas/sas7bdat-read.js";
import { beginWritingSas7bdat } from "./sas/sas7bdat-write.js";
import { parseTxt } from "./txt/txt-read.js";
import { parseStataDictionary } from "./txt/stata-dictionary.js";
import { parseSpssCommands } from "./txt/spss-commands.js";
import { parseSasCommands } from "./txt/sas-commands.js";
import type { Schema } from "./txt/schema.js";

export type CellValue = number | string | null;

export interface ValueLabelPair {
  value: CellValue;
  label: string;
}

export interface DatasetVariable {
  index: number;
  name: string;
  label: string | null;
  type: ReadStatType;
  format: string | null;
  measure: ReadStatMeasure;
  alignment: ReadStatAlignment;
  displayWidth: number;
  storageWidth: number;
  valueLabelsName: string | null;
  valueLabels: ValueLabelPair[] | null;
  missingRanges: { lo: CellValue; hi: CellValue }[];
}

export interface Dataset {
  metadata: ReadStatMetadata;
  variables: DatasetVariable[];
  rows: CellValue[][];
  notes: string[];
  /** Convert rows into an array of `{ [varName]: value }` objects. */
  toObjects(): Record<string, CellValue>[];
}

export type ReadableFormat = "sav" | "zsav" | "dta" | "por" | "sas7bdat" | "xport";

type ParseFn = (parser: ReadStatParser, io: IoContext, userCtx: unknown) => ReadStatError;

const PARSERS: Partial<Record<ReadableFormat, ParseFn>> = {
  sav: parseSav,
  zsav: parseSav,
  dta: parseDta,
  por: parsePor,
  xport: parseXport,
  sas7bdat: parseSas7bdat,
};

export interface ReadOptions {
  /** Override the file's declared character encoding (iconv-style name). */
  inputEncoding?: string | null;
  rowLimit?: number;
  rowOffset?: number;
}

/** Parse an in-memory data file into a fully materialized Dataset. */
export function readData(format: ReadableFormat, data: Uint8Array, options: ReadOptions = {}): Dataset {
  const parse = PARSERS[format];
  if (!parse) throw new Error(`Reading '${format}' is not yet supported`);

  const parser = new ReadStatParser();
  if (options.inputEncoding !== undefined) parser.setFileCharacterEncoding(options.inputEncoding);
  if (options.rowLimit !== undefined) parser.setRowLimit(options.rowLimit);
  if (options.rowOffset !== undefined) parser.setRowOffset(options.rowOffset);

  let metadata: ReadStatMetadata | null = null;
  const variables: DatasetVariable[] = [];
  const rows: CellValue[][] = [];
  const notes: string[] = [];
  const valueLabelSets = new Map<string, ValueLabelPair[]>();
  const varsByLabelName = new Map<string, DatasetVariable[]>();

  parser.setMetadataHandler((m) => {
    metadata = m;
  });
  parser.setNoteHandler((_i, note) => {
    notes.push(note);
  });
  parser.setVariableHandler((index, v: Variable, valLabels) => {
    const missingRanges = [];
    for (let i = 0; i < v.getMissingRangesCount(); i++) {
      missingRanges.push({ lo: v.getMissingRangeLo(i).toJS(), hi: v.getMissingRangeHi(i).toJS() });
    }
    const dv: DatasetVariable = {
      index,
      name: v.getName() ?? "",
      label: v.getLabel(),
      type: v.type,
      format: v.getFormat(),
      measure: v.measure,
      alignment: v.alignment,
      displayWidth: v.displayWidth,
      storageWidth: v.storageWidth,
      valueLabelsName: valLabels,
      valueLabels: null,
      missingRanges,
    };
    variables[index] = dv;
    if (valLabels) {
      let arr = varsByLabelName.get(valLabels);
      if (!arr) varsByLabelName.set(valLabels, (arr = []));
      arr.push(dv);
    }
  });
  parser.setValueHandler((obsIndex, v: Variable, value) => {
    let row = rows[obsIndex];
    if (!row) rows[obsIndex] = row = [];
    row[v.index] = value.toJS();
  });
  parser.setValueLabelHandler((name, value, label) => {
    let arr = valueLabelSets.get(name);
    if (!arr) valueLabelSets.set(name, (arr = []));
    arr.push({ value: value.toJS(), label });
  });

  const code = parse(parser, new BufferIoContext(data), null);
  if (code !== ReadStatError.OK) {
    throw new ReadStatException(code, readstatErrorMessage(code) ?? undefined);
  }

  // attach value labels to variables
  for (const [name, pairs] of valueLabelSets) {
    const vars = varsByLabelName.get(name);
    if (vars) for (const v of vars) v.valueLabels = pairs;
  }

  const md = metadata ?? {
    rowCount: rows.length,
    varCount: variables.length,
    creationTime: 0,
    modifiedTime: 0,
    fileFormatVersion: 0,
    compression: ReadStatCompress.NONE,
    endianness: 0,
    tableName: null,
    fileLabel: null,
    fileEncoding: null,
    is64bit: false,
    multipleResponseSets: [],
  };

  return {
    metadata: md,
    variables: variables.filter((v) => v !== undefined),
    rows,
    notes,
    toObjects() {
      return rows.map((row) => {
        const obj: Record<string, CellValue> = {};
        for (const v of variables) if (v) obj[v.name] = row[v.index] ?? null;
        return obj;
      });
    },
  };
}

/** Auto-detect the format from the file's magic bytes. */
export function detectFormat(data: Uint8Array): ReadableFormat | null {
  const b = data;
  if (b.length >= 4) {
    const m4 = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (m4 === "$FL2") return "sav";
    if (m4 === "$FL3") return "zsav";
    if (m4 === "<sta") return "dta";
  }
  // XPORT: begins with "HEADER RECORD"
  if (b.length >= 13) {
    let hdr = "";
    for (let i = 0; i < 13; i++) hdr += String.fromCharCode(b[i]);
    if (hdr === "HEADER RECORD") return "xport";
  }
  // legacy DTA: first byte is a version 104-115, byteorder 1/2
  if (b.length >= 2 && b[0] >= 104 && b[0] <= 116 && (b[1] === 1 || b[1] === 2)) return "dta";
  // SAS7BDAT magic
  const sasMagic = [0xc2, 0xea, 0x81, 0x60, 0xb3, 0x14, 0x11, 0xcf];
  if (b.length >= 32 && sasMagic.every((x, i) => b[12 + i] === x)) return "sas7bdat";
  return null;
}

export function readSav(data: Uint8Array, options?: ReadOptions): Dataset {
  return readData("sav", data, options);
}
export function readDta(data: Uint8Array, options?: ReadOptions): Dataset {
  return readData("dta", data, options);
}

// ---- writing ----

export type WritableFormat = "sav" | "zsav" | "dta" | "por" | "xport" | "sas7bdat";

export interface WriteVariable {
  name: string;
  type: ReadStatType;
  /** For strings: storage width in bytes. For SAS XPORT doubles: 3-8. */
  storageWidth?: number;
  label?: string;
  format?: string;
  measure?: ReadStatMeasure;
  alignment?: ReadStatAlignment;
  displayWidth?: number;
  /** Named value-label set (must match a key in `valueLabelSets`). */
  valueLabels?: string;
  missingValues?: number[];
  missingRanges?: [number, number][];
}

export interface WriteValueLabel {
  value: number | string;
  label: string;
  tag?: string;
}

export interface WriteSpec {
  variables: WriteVariable[];
  rows: CellValue[][];
  valueLabelSets?: Record<string, WriteValueLabel[]>;
  fileLabel?: string;
  notes?: string[];
  timestamp?: number; // seconds since epoch
  version?: number;
  compression?: ReadStatCompress;
}

type BeginFn = (writer: Writer, userCtx: unknown, rowCount: number) => ReadStatError;
const WRITERS: Record<WritableFormat, BeginFn> = {
  sav: beginWritingSav,
  zsav: beginWritingSav,
  dta: beginWritingDta,
  por: beginWritingPor,
  xport: beginWritingXport,
  sas7bdat: beginWritingSas7bdat,
};

function checkErr(code: ReadStatError): void {
  if (code !== ReadStatError.OK) {
    throw new ReadStatException(code, readstatErrorMessage(code) ?? undefined);
  }
}

/** Serialize a dataset spec into an in-memory data file. */
export function writeData(format: WritableFormat, spec: WriteSpec): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new Writer();
  writer.setDataWriter((d) => {
    chunks.push(d.slice());
    return d.length;
  });

  if (spec.fileLabel) writer.setFileLabel(spec.fileLabel);
  if (spec.timestamp !== undefined) writer.setFileTimestamp(spec.timestamp);
  if (spec.version !== undefined) writer.setFileFormatVersion(spec.version);
  if (format === "zsav") writer.setCompression(ReadStatCompress.BINARY);
  else if (spec.compression !== undefined) writer.setCompression(spec.compression);
  if (spec.notes) for (const note of spec.notes) writer.addNote(note);

  // value label sets
  const labelSets = new Map<string, LabelSet>();
  if (spec.valueLabelSets) {
    for (const [name, labels] of Object.entries(spec.valueLabelSets)) {
      // infer set type from first label value
      const first = labels[0];
      const type =
        first && typeof first.value === "string" ? ReadStatType.STRING : ReadStatType.DOUBLE;
      const ls = writer.addLabelSet(type, name);
      for (const l of labels) {
        if (l.tag) ls.labelTaggedValue(l.tag, l.label);
        else if (typeof l.value === "string") ls.labelStringValue(l.value, l.label);
        else ls.labelDoubleValue(l.value, l.label);
      }
      labelSets.set(name, ls);
    }
  }

  // variables
  const vars: Variable[] = [];
  for (const wv of spec.variables) {
    const v = writer.addVariable(wv.name, wv.type, wv.storageWidth ?? 0);
    if (wv.label !== undefined) v.setLabel(wv.label);
    if (wv.format !== undefined) v.setFormat(wv.format);
    if (wv.measure !== undefined) v.setMeasure(wv.measure);
    if (wv.alignment !== undefined) v.setAlignment(wv.alignment);
    if (wv.displayWidth !== undefined) v.setDisplayWidth(wv.displayWidth);
    if (wv.valueLabels) {
      const ls = labelSets.get(wv.valueLabels);
      if (ls) writer.setVariableLabelSet(v, ls);
    }
    if (wv.missingValues) for (const mv of wv.missingValues) v.addMissingDoubleValue(mv);
    if (wv.missingRanges) for (const [lo, hi] of wv.missingRanges) v.addMissingDoubleRange(lo, hi);
    vars.push(v);
  }

  checkErr(WRITERS[format](writer, null, spec.rows.length));

  for (const row of spec.rows) {
    checkErr(writer.beginRow());
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      const cell = row[i];
      if (cell === null || cell === undefined) {
        checkErr(writer.insertMissingValue(v));
        continue;
      }
      switch (v.type) {
        case ReadStatType.INT8:
          checkErr(writer.insertInt8Value(v, cell as number));
          break;
        case ReadStatType.INT16:
          checkErr(writer.insertInt16Value(v, cell as number));
          break;
        case ReadStatType.INT32:
          checkErr(writer.insertInt32Value(v, cell as number));
          break;
        case ReadStatType.FLOAT:
          checkErr(writer.insertFloatValue(v, cell as number));
          break;
        case ReadStatType.DOUBLE:
          checkErr(writer.insertDoubleValue(v, cell as number));
          break;
        case ReadStatType.STRING:
          checkErr(writer.insertStringValue(v, String(cell)));
          break;
        default:
          checkErr(writer.insertMissingValue(v));
      }
    }
    checkErr(writer.endRow());
  }
  checkErr(writer.endWriting());

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function writeSav(spec: WriteSpec): Uint8Array {
  return writeData("sav", spec);
}
export function writeZsav(spec: WriteSpec): Uint8Array {
  return writeData("zsav", spec);
}
export function writeDta(spec: WriteSpec): Uint8Array {
  return writeData("dta", spec);
}
export function writePor(spec: WriteSpec): Uint8Array {
  return writeData("por", spec);
}
export function readPor(data: Uint8Array, options?: ReadOptions): Dataset {
  return readData("por", data, options);
}
export function writeXport(spec: WriteSpec): Uint8Array {
  return writeData("xport", spec);
}
export function readXport(data: Uint8Array, options?: ReadOptions): Dataset {
  return readData("xport", data, options);
}
export function readSas7bdat(data: Uint8Array, options?: ReadOptions): Dataset {
  return readData("sas7bdat", data, options);
}
export function writeSas7bdat(spec: WriteSpec): Uint8Array {
  return writeData("sas7bdat", spec);
}

// ---- plain-text data with an external schema ----

export type SchemaFormat = "stata" | "spss" | "sas";

/**
 * Read a plain-text data file described by an external schema file
 * (Stata dictionary `.dct`, SPSS command file `.sps`, or SAS command file
 * `.sas`).
 */
export function readTxt(data: Uint8Array, schemaBytes: Uint8Array, schemaFormat: SchemaFormat, options: ReadOptions = {}): Dataset {
  const parser = new ReadStatParser();
  if (options.inputEncoding !== undefined) parser.setFileCharacterEncoding(options.inputEncoding);
  if (options.rowLimit !== undefined) parser.setRowLimit(options.rowLimit);

  let metadata: ReadStatMetadata | null = null;
  const variables: DatasetVariable[] = [];
  const rows: CellValue[][] = [];
  const notes: string[] = [];
  const valueLabelSets = new Map<string, ValueLabelPair[]>();
  const varsByLabelName = new Map<string, DatasetVariable[]>();

  parser.setMetadataHandler((m) => {
    metadata = m;
  });
  parser.setVariableHandler((index, v: Variable, valLabels) => {
    const dv: DatasetVariable = {
      index,
      name: v.getName() ?? "",
      label: v.getLabel(),
      type: v.type,
      format: v.getFormat(),
      measure: v.measure,
      alignment: v.alignment,
      displayWidth: v.displayWidth,
      storageWidth: v.storageWidth,
      valueLabelsName: valLabels,
      valueLabels: null,
      missingRanges: [],
    };
    variables[index] = dv;
    if (valLabels) {
      let arr = varsByLabelName.get(valLabels);
      if (!arr) varsByLabelName.set(valLabels, (arr = []));
      arr.push(dv);
    }
  });
  parser.setValueHandler((obsIndex, v: Variable, value) => {
    let row = rows[obsIndex];
    if (!row) rows[obsIndex] = row = [];
    row[v.index] = value.toJS();
  });
  parser.setValueLabelHandler((name, value, label) => {
    let arr = valueLabelSets.get(name);
    if (!arr) valueLabelSets.set(name, (arr = []));
    arr.push({ value: value.toJS(), label });
  });

  let schema: Schema;
  if (schemaFormat === "stata") schema = parseStataDictionary(parser, schemaBytes, null);
  else if (schemaFormat === "spss") schema = parseSpssCommands(parser, schemaBytes, null);
  else schema = parseSasCommands(parser, schemaBytes, null);

  const code = parseTxt(parser, new BufferIoContext(data), schema, null);
  if (code !== ReadStatError.OK) throw new ReadStatException(code, readstatErrorMessage(code) ?? undefined);

  for (const [name, pairs] of valueLabelSets) {
    const vars = varsByLabelName.get(name);
    if (vars) for (const v of vars) v.valueLabels = pairs;
  }

  const md = metadata ?? { ...makeEmptyMd(), rowCount: rows.length, varCount: variables.length };
  return {
    metadata: md,
    variables: variables.filter((v) => v !== undefined),
    rows,
    notes,
    toObjects() {
      return rows.map((row) => {
        const obj: Record<string, CellValue> = {};
        for (const v of variables) if (v) obj[v.name] = row[v.index] ?? null;
        return obj;
      });
    },
  };
}

function makeEmptyMd(): ReadStatMetadata {
  return {
    rowCount: -1, varCount: 0, creationTime: 0, modifiedTime: 0, fileFormatVersion: 0,
    compression: ReadStatCompress.NONE, endianness: 0, tableName: null, fileLabel: null,
    fileEncoding: null, is64bit: false, multipleResponseSets: [],
  };
}
