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
export { parsePor } from "./spss/por-read.js";
export { beginWritingPor } from "./spss/por-write.js";
export { parseDta } from "./stata/dta-read.js";
export { beginWritingDta } from "./stata/dta-write.js";
export { parseXport } from "./sas/xport-read.js";
export { beginWritingXport } from "./sas/xport-write.js";
export { parseSas7bdat } from "./sas/sas7bdat-read.js";
export { beginWritingSas7bdat } from "./sas/sas7bdat-write.js";
export { parseSas7bcat, beginWritingSas7bcat } from "./sas/sas7bcat.js";
export { parseTxt } from "./txt/txt-read.js";
export { parseStataDictionary } from "./txt/stata-dictionary.js";
export { parseSpssCommands } from "./txt/spss-commands.js";
export { parseSasCommands } from "./txt/sas-commands.js";
export { type Schema, type SchemaEntry } from "./txt/schema.js";

// High-level API
export {
  readData,
  readSav,
  readDta,
  readPor,
  readXport,
  readSas7bdat,
  detectFormat,
  writeData,
  writeSav,
  writeZsav,
  writeDta,
  writePor,
  writeXport,
  writeSas7bdat,
  readTxt,
  type SchemaFormat,
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
