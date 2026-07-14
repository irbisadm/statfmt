//
// spss/spss.ts — Shared SPSS helpers (port of readstat_spss.c / .h and
// readstat_spss_parse.rl)
//

import {
  ReadStatType,
  ReadStatMeasure,
  ReadStatAlignment,
} from "../types.js";
import { ReadStatError } from "../errors.js";
import { ReadStatValue, makeDoubleValue, makeStringValue } from "../value.js";
import { Variable, Missingness } from "../variable.js";
import { Codec, convertString } from "../codec.js";

// ---- format type codes ----
export const SPSS_FORMAT_TYPE_A = 1;
export const SPSS_FORMAT_TYPE_AHEX = 2;
export const SPSS_FORMAT_TYPE_COMMA = 3;
export const SPSS_FORMAT_TYPE_DOLLAR = 4;
export const SPSS_FORMAT_TYPE_F = 5;
export const SPSS_FORMAT_TYPE_IB = 6;
export const SPSS_FORMAT_TYPE_PIBHEX = 7;
export const SPSS_FORMAT_TYPE_P = 8;
export const SPSS_FORMAT_TYPE_PIB = 9;
export const SPSS_FORMAT_TYPE_PK = 10;
export const SPSS_FORMAT_TYPE_RB = 11;
export const SPSS_FORMAT_TYPE_RBHEX = 12;
export const SPSS_FORMAT_TYPE_Z = 15;
export const SPSS_FORMAT_TYPE_N = 16;
export const SPSS_FORMAT_TYPE_E = 17;
export const SPSS_FORMAT_TYPE_DATE = 20;
export const SPSS_FORMAT_TYPE_TIME = 21;
export const SPSS_FORMAT_TYPE_DATETIME = 22;
export const SPSS_FORMAT_TYPE_ADATE = 23;
export const SPSS_FORMAT_TYPE_JDATE = 24;
export const SPSS_FORMAT_TYPE_DTIME = 25;
export const SPSS_FORMAT_TYPE_WKDAY = 26;
export const SPSS_FORMAT_TYPE_MONTH = 27;
export const SPSS_FORMAT_TYPE_MOYR = 28;
export const SPSS_FORMAT_TYPE_QYR = 29;
export const SPSS_FORMAT_TYPE_WKYR = 30;
export const SPSS_FORMAT_TYPE_PCT = 31;
export const SPSS_FORMAT_TYPE_DOT = 32;
export const SPSS_FORMAT_TYPE_CCA = 33;
export const SPSS_FORMAT_TYPE_CCB = 34;
export const SPSS_FORMAT_TYPE_CCC = 35;
export const SPSS_FORMAT_TYPE_CCD = 36;
export const SPSS_FORMAT_TYPE_CCE = 37;
export const SPSS_FORMAT_TYPE_EDATE = 38;
export const SPSS_FORMAT_TYPE_SDATE = 39;
export const SPSS_FORMAT_TYPE_MTIME = 40;
export const SPSS_FORMAT_TYPE_YMDHMS = 41;

export const SPSS_DOC_LINE_SIZE = 80;

export const SAV_HIGHEST_DOUBLE = 0x7fefffffffffffffn;
export const SAV_MISSING_DOUBLE = 0xffefffffffffffffn;
export const SAV_LOWEST_DOUBLE = 0xffeffffffffffffen;

export const SAV_MEASURE_UNKNOWN = 0;
export const SAV_MEASURE_NOMINAL = 1;
export const SAV_MEASURE_ORDINAL = 2;
export const SAV_MEASURE_SCALE = 3;

export const SAV_ALIGNMENT_LEFT = 0;
export const SAV_ALIGNMENT_RIGHT = 1;
export const SAV_ALIGNMENT_CENTER = 2;

const TYPE_STRINGS: Record<number, string> = {
  [SPSS_FORMAT_TYPE_A]: "A",
  [SPSS_FORMAT_TYPE_AHEX]: "AHEX",
  [SPSS_FORMAT_TYPE_COMMA]: "COMMA",
  [SPSS_FORMAT_TYPE_DOLLAR]: "DOLLAR",
  [SPSS_FORMAT_TYPE_F]: "F",
  [SPSS_FORMAT_TYPE_IB]: "IB",
  [SPSS_FORMAT_TYPE_PIBHEX]: "PIBHEX",
  [SPSS_FORMAT_TYPE_P]: "P",
  [SPSS_FORMAT_TYPE_PIB]: "PIB",
  [SPSS_FORMAT_TYPE_PK]: "PK",
  [SPSS_FORMAT_TYPE_RB]: "RB",
  [SPSS_FORMAT_TYPE_RBHEX]: "RBHEX",
  [SPSS_FORMAT_TYPE_Z]: "Z",
  [SPSS_FORMAT_TYPE_N]: "N",
  [SPSS_FORMAT_TYPE_E]: "E",
  [SPSS_FORMAT_TYPE_DATE]: "DATE",
  [SPSS_FORMAT_TYPE_TIME]: "TIME",
  [SPSS_FORMAT_TYPE_DATETIME]: "DATETIME",
  [SPSS_FORMAT_TYPE_ADATE]: "ADATE",
  [SPSS_FORMAT_TYPE_JDATE]: "JDATE",
  [SPSS_FORMAT_TYPE_DTIME]: "DTIME",
  [SPSS_FORMAT_TYPE_WKDAY]: "WKDAY",
  [SPSS_FORMAT_TYPE_MONTH]: "MONTH",
  [SPSS_FORMAT_TYPE_MOYR]: "MOYR",
  [SPSS_FORMAT_TYPE_QYR]: "QYR",
  [SPSS_FORMAT_TYPE_WKYR]: "WKYR",
  [SPSS_FORMAT_TYPE_PCT]: "PCT",
  [SPSS_FORMAT_TYPE_DOT]: "DOT",
  [SPSS_FORMAT_TYPE_CCA]: "CCA",
  [SPSS_FORMAT_TYPE_CCB]: "CCB",
  [SPSS_FORMAT_TYPE_CCC]: "CCC",
  [SPSS_FORMAT_TYPE_CCD]: "CCD",
  [SPSS_FORMAT_TYPE_CCE]: "CCE",
  [SPSS_FORMAT_TYPE_EDATE]: "EDATE",
  [SPSS_FORMAT_TYPE_SDATE]: "SDATE",
  [SPSS_FORMAT_TYPE_MTIME]: "MTIME",
  [SPSS_FORMAT_TYPE_YMDHMS]: "YMDHMS",
};

// default widths applied by the format parser when matching a type token
const TYPE_DEFAULT_WIDTH: Record<string, number> = {
  DATE: 11,
  DATETIME: 20,
  YMDHMS: 19,
  ADATE: 10,
  DTIME: 23,
  WKYR: 10,
  EDATE: 10,
  SDATE: 10,
};

// name -> code, ordered so that longer tokens are tried before their prefixes
const TYPE_TOKENS: [string, number][] = Object.entries(TYPE_STRINGS)
  .map(([code, name]) => [name, Number(code)] as [string, number])
  .sort((a, b) => b[0].length - a[0].length);

export interface SpssFormat {
  type: number;
  width: number;
  decimalPlaces: number;
}

export function makeSpssFormat(): SpssFormat {
  return { type: 0, width: 0, decimalPlaces: 0 };
}

/** Render an SPSS format struct as a string (port of spss_format). */
export function spssFormatToString(format: SpssFormat): string | null {
  const string = TYPE_STRINGS[format.type];
  if (!string) return null;
  if (format.decimalPlaces || format.type === SPSS_FORMAT_TYPE_F) {
    return `${string}${format.width}.${format.decimalPlaces}`;
  } else if (format.width) {
    return `${string}${format.width}`;
  }
  return string;
}

/** Parse an SPSS format string into `fmt` (port of spss_parse_format). */
export function spssParseFormat(data: string, fmt: SpssFormat): ReadStatError {
  const upper = data.toUpperCase();
  for (const [name, code] of TYPE_TOKENS) {
    if (!upper.startsWith(name)) continue;
    const rest = data.slice(name.length);
    // rest must be: [0-9]* ("." [0-9]+)?
    const m = /^(\d+)?(?:\.(\d+))?$/.exec(rest);
    if (!m) {
      // this token's remainder doesn't parse; try a shorter token
      continue;
    }
    if (rest.length > 0 && m[1] === undefined && m[2] === undefined) {
      continue;
    }
    fmt.type = code;
    fmt.width = TYPE_DEFAULT_WIDTH[name] ?? 0;
    if (m[1] !== undefined) fmt.width = parseInt(m[1], 10);
    if (m[2] !== undefined) fmt.decimalPlaces = parseInt(m[2], 10);
    return ReadStatError.OK;
  }
  return ReadStatError.ERROR_PARSE;
}

// ---- variable info (parsed dictionary entry) ----

export interface SpssVarinfo {
  type: ReadStatType;
  labelsIndex: number;
  index: number;
  offset: number;
  width: number;
  stringLength: number;
  printFormat: SpssFormat;
  writeFormat: SpssFormat;
  nSegments: number;
  nMissingValues: number;
  missingRange: number;
  missingDoubleValues: number[]; // length 3
  missingStringValues: string[]; // length 3, stored UTF-8
  name: Uint8Array; // stored UNCONVERTED (<= 8 bytes)
  longname: Uint8Array; // stored UNCONVERTED (<= 64 bytes)
  label: string | null; // stored UTF-8
  measure: ReadStatMeasure;
  alignment: ReadStatAlignment;
  displayWidth: number;
}

export function makeVarinfo(): SpssVarinfo {
  return {
    type: ReadStatType.DOUBLE,
    labelsIndex: -1,
    index: 0,
    offset: 0,
    width: 0,
    stringLength: 0,
    printFormat: makeSpssFormat(),
    writeFormat: makeSpssFormat(),
    nSegments: 1,
    nMissingValues: 0,
    missingRange: 0,
    missingDoubleValues: [0, 0, 0],
    missingStringValues: ["", "", ""],
    name: new Uint8Array(0),
    longname: new Uint8Array(0),
    label: null,
    measure: ReadStatMeasure.UNKNOWN,
    alignment: ReadStatAlignment.UNKNOWN,
    displayWidth: 0,
  };
}

function boxedMissingValue(info: SpssVarinfo, i: number): ReadStatValue {
  if (info.type === ReadStatType.DOUBLE) {
    return makeDoubleValue(info.missingDoubleValues[i]);
  }
  return makeStringValue(info.missingStringValues[i]);
}

export function spssMissingnessForInfo(info: SpssVarinfo): Missingness {
  const missingness: Missingness = { ranges: [], count: 0 };
  if (info.missingRange) {
    missingness.count++;
    missingness.ranges[0] = boxedMissingValue(info, 0);
    missingness.ranges[1] = boxedMissingValue(info, 1);
    if (info.nMissingValues === 3) {
      missingness.count++;
      const v = boxedMissingValue(info, 2);
      missingness.ranges[2] = v;
      missingness.ranges[3] = v;
    }
  } else if (info.nMissingValues > 0) {
    missingness.count = info.nMissingValues;
    for (let i = 0; i < info.nMissingValues; i++) {
      const v = boxedMissingValue(info, i);
      missingness.ranges[2 * i] = v;
      missingness.ranges[2 * i + 1] = v;
    }
  }
  return missingness;
}

export function spssInitVariableForInfo(
  info: SpssVarinfo,
  indexAfterSkipping: number,
  codec: Codec,
  encoding: string,
): Variable {
  const variable = new Variable(info.type, info.index);
  variable.indexAfterSkipping = indexAfterSkipping;
  if (info.stringLength) {
    variable.storageWidth = info.stringLength;
  } else {
    variable.storageWidth = 8 * info.width;
  }
  if (info.longname.length && info.longname[0]) {
    variable.name = convertString(codec, info.longname, encoding);
  } else {
    variable.name = convertString(codec, info.name, encoding);
  }
  if (info.label) {
    variable.label = info.label.slice(0, 1023);
  }
  const formatStr = spssFormatToString(info.printFormat);
  variable.format = formatStr ?? "";
  variable.missingness = spssMissingnessForInfo(info);
  variable.measure = info.measure;
  if (info.displayWidth) {
    variable.displayWidth = info.displayWidth;
  } else {
    variable.displayWidth = info.printFormat.width;
  }
  variable.alignment = info.alignment;
  return variable;
}

export function spssMeasureFromReadstat(measure: ReadStatMeasure): number {
  if (measure === ReadStatMeasure.NOMINAL) return SAV_MEASURE_NOMINAL;
  if (measure === ReadStatMeasure.ORDINAL) return SAV_MEASURE_ORDINAL;
  if (measure === ReadStatMeasure.SCALE) return SAV_MEASURE_SCALE;
  return SAV_MEASURE_UNKNOWN;
}
export function spssMeasureToReadstat(savMeasure: number): ReadStatMeasure {
  if (savMeasure === SAV_MEASURE_NOMINAL) return ReadStatMeasure.NOMINAL;
  if (savMeasure === SAV_MEASURE_ORDINAL) return ReadStatMeasure.ORDINAL;
  if (savMeasure === SAV_MEASURE_SCALE) return ReadStatMeasure.SCALE;
  return ReadStatMeasure.UNKNOWN;
}
export function spssAlignmentFromReadstat(alignment: ReadStatAlignment): number {
  if (alignment === ReadStatAlignment.LEFT) return SAV_ALIGNMENT_LEFT;
  if (alignment === ReadStatAlignment.CENTER) return SAV_ALIGNMENT_CENTER;
  if (alignment === ReadStatAlignment.RIGHT) return SAV_ALIGNMENT_RIGHT;
  return SAV_ALIGNMENT_LEFT;
}
export function spssAlignmentToReadstat(savAlignment: number): ReadStatAlignment {
  if (savAlignment === SAV_ALIGNMENT_LEFT) return ReadStatAlignment.LEFT;
  if (savAlignment === SAV_ALIGNMENT_CENTER) return ReadStatAlignment.CENTER;
  if (savAlignment === SAV_ALIGNMENT_RIGHT) return ReadStatAlignment.RIGHT;
  return ReadStatAlignment.UNKNOWN;
}

/** Bit pattern (as an unsigned 64-bit BigInt) of an SPSS numeric value. */
export function spss64bitValue(value: ReadStatValue): bigint {
  const dval = value.doubleValue();
  if (!Number.isFinite(dval)) {
    if (Number.isNaN(dval)) return SAV_MISSING_DOUBLE;
    return dval < 0 ? SAV_LOWEST_DOUBLE : SAV_HIGHEST_DOUBLE;
  }
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, dval, true);
  return dv.getBigUint64(0, true);
}

export function spssFormatForVariable(variable: Variable): { retval: ReadStatError; format: SpssFormat } {
  const format = makeSpssFormat();
  if (variable.type === ReadStatType.STRING) {
    format.type = SPSS_FORMAT_TYPE_A;
    if (variable.displayWidth) {
      format.width = variable.displayWidth;
    } else if (variable.userWidth) {
      format.width = variable.userWidth;
    } else {
      format.width = variable.storageWidth;
    }
  } else {
    format.type = SPSS_FORMAT_TYPE_F;
    if (variable.displayWidth) {
      format.width = variable.displayWidth;
    } else {
      format.width = 8;
    }
    if (variable.type === ReadStatType.DOUBLE || variable.type === ReadStatType.FLOAT) {
      format.decimalPlaces = 2;
    }
  }
  if (variable.format && variable.format[0]) {
    format.decimalPlaces = 0;
    const retval = spssParseFormat(variable.format, format);
    if (retval !== ReadStatError.OK) {
      return { retval: ReadStatError.ERROR_BAD_FORMAT_STRING, format };
    }
  }
  return { retval: ReadStatError.OK, format };
}
