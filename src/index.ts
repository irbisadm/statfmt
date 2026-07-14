//
// readstat-ts — TypeScript port of ReadStat
//
// Read and write SPSS (.sav/.zsav/.por), Stata (.dta) and SAS
// (.sas7bdat/.sas7bcat/.xpt) data files.
//

export * from "./types.js";
export * from "./errors.js";
export { ReadStatValue } from "./value.js";
export {
  Variable,
  valueIsMissing,
  valueIsDefinedMissing,
  type Missingness,
} from "./variable.js";
export { LabelSet, type ValueLabel } from "./labelset.js";
export { BinaryReader, BinaryWriter } from "./binary.js";
export { BufferIoContext, type IoContext } from "./io.js";
export { DefaultCodec, defaultCodec, normalizeEncoding, type Codec } from "./codec.js";
export { ReadStatParser } from "./parser.js";
export type {
  Handlers,
  MetadataHandler,
  NoteHandler,
  VariableHandler,
  FweightHandler,
  ValueHandler,
  ValueLabelHandler,
  ErrorHandler,
  ProgressHandler,
} from "./parser.js";
export { Writer, stringRefInit, type StringRef, type WriterModuleCallbacks } from "./writer.js";

// Streaming format entry points (low-level)
export { parseSav } from "./spss/sav-read.js";
export { beginWritingSav } from "./spss/sav-write.js";
export { parseDta } from "./stata/dta-read.js";
export { beginWritingDta } from "./stata/dta-write.js";

// High-level API
export {
  readData,
  readSav,
  readDta,
  detectFormat,
  writeData,
  writeSav,
  writeZsav,
  writeDta,
  type Dataset,
  type DatasetVariable,
  type CellValue,
  type ValueLabelPair,
  type ReadableFormat,
  type WritableFormat,
  type ReadOptions,
  type WriteSpec,
  type WriteVariable,
  type WriteValueLabel,
} from "./highlevel.js";
