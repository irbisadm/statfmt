//
// types.ts — Core enums and data structures (port of readstat.h)
//
// Copyright Evan Miller and ReadStat authors (original C library, see LICENSE)
// TypeScript port.
//

/** Handler return codes. Callbacks return OK to continue, ABORT to stop. */
export enum HandlerStatus {
  OK = 0,
  ABORT = 1,
  SKIP_VARIABLE = 2,
}

/** Storage/value type. Numeric values match the C `readstat_type_t` enum. */
export enum ReadStatType {
  STRING = 0,
  INT8 = 1,
  INT16 = 2,
  INT32 = 3,
  FLOAT = 4,
  DOUBLE = 5,
  STRING_REF = 6,
}

export enum ReadStatTypeClass {
  STRING = 0,
  NUMERIC = 1,
}

export enum ReadStatMeasure {
  UNKNOWN = 0,
  NOMINAL = 1,
  ORDINAL = 2,
  SCALE = 3,
}

export enum ReadStatAlignment {
  UNKNOWN = 0,
  LEFT = 1,
  CENTER = 2,
  RIGHT = 3,
}

export enum ReadStatCompress {
  NONE = 0,
  ROWS = 1,
  BINARY = 2,
}

export enum ReadStatEndian {
  NONE = 0,
  LITTLE = 1,
  BIG = 2,
}

/** seek whence flags */
export enum ReadStatSeek {
  SET = 0,
  CUR = 1,
  END = 2,
}

/** Return the type class (string vs numeric) for a storage type. */
export function readstatTypeClass(type: ReadStatType): ReadStatTypeClass {
  if (type === ReadStatType.STRING || type === ReadStatType.STRING_REF) {
    return ReadStatTypeClass.STRING;
  }
  return ReadStatTypeClass.NUMERIC;
}

/** A multiple-response set (SPSS). */
export interface MrSet {
  type: string; // 'C' or 'D' or 'E'
  name: string;
  label: string;
  isDichotomy: boolean;
  countedValue: number;
  subvariables: string[];
}

/** File-level metadata delivered to the metadata handler. */
export interface ReadStatMetadata {
  rowCount: number; // -1 if unknown
  varCount: number;
  /** creation time — seconds since Unix epoch (like C time_t) */
  creationTime: number;
  /** modification time — seconds since Unix epoch */
  modifiedTime: number;
  fileFormatVersion: number;
  compression: ReadStatCompress;
  endianness: ReadStatEndian;
  tableName: string | null;
  fileLabel: string | null;
  fileEncoding: string | null;
  is64bit: boolean;
  multipleResponseSets: MrSet[];
}

export function makeEmptyMetadata(): ReadStatMetadata {
  return {
    rowCount: -1,
    varCount: 0,
    creationTime: 0,
    modifiedTime: 0,
    fileFormatVersion: 0,
    compression: ReadStatCompress.NONE,
    endianness: ReadStatEndian.NONE,
    tableName: null,
    fileLabel: null,
    fileEncoding: null,
    is64bit: false,
    multipleResponseSets: [],
  };
}
