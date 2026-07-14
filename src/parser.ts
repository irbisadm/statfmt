//
// parser.ts — readstat_parser_t: handler registry and parse options
// (port of readstat_parser.c)
//

import type { ReadStatMetadata } from "./types.js";
import type { Variable } from "./variable.js";
import type { ReadStatValue } from "./value.js";
import type { IoContext } from "./io.js";
import { Codec, defaultCodec } from "./codec.js";
import { HandlerStatus } from "./types.js";

export type HandlerResult = HandlerStatus | number | void;

export type MetadataHandler = (metadata: ReadStatMetadata, ctx: unknown) => HandlerResult;
export type NoteHandler = (noteIndex: number, note: string, ctx: unknown) => HandlerResult;
export type VariableHandler = (
  index: number,
  variable: Variable,
  valLabels: string | null,
  ctx: unknown,
) => HandlerResult;
export type FweightHandler = (variable: Variable, ctx: unknown) => HandlerResult;
export type ValueHandler = (
  obsIndex: number,
  variable: Variable,
  value: ReadStatValue,
  ctx: unknown,
) => HandlerResult;
export type ValueLabelHandler = (
  valLabels: string,
  value: ReadStatValue,
  label: string,
  ctx: unknown,
) => HandlerResult;
export type ErrorHandler = (message: string, ctx: unknown) => void;
export type ProgressHandler = (progress: number, ctx: unknown) => HandlerResult;

export interface Handlers {
  metadata?: MetadataHandler;
  note?: NoteHandler;
  variable?: VariableHandler;
  fweight?: FweightHandler;
  value?: ValueHandler;
  valueLabel?: ValueLabelHandler;
  error?: ErrorHandler;
  progress?: ProgressHandler;
}

export class ReadStatParser {
  handlers: Handlers = {};
  io: IoContext | null = null;
  inputEncoding: string | null = null;
  outputEncoding: string | null = "UTF-8";
  rowLimit = 0;
  rowOffset = 0;
  codec: Codec = defaultCodec;

  setMetadataHandler(h: MetadataHandler): this {
    this.handlers.metadata = h;
    return this;
  }
  setNoteHandler(h: NoteHandler): this {
    this.handlers.note = h;
    return this;
  }
  setVariableHandler(h: VariableHandler): this {
    this.handlers.variable = h;
    return this;
  }
  setFweightHandler(h: FweightHandler): this {
    this.handlers.fweight = h;
    return this;
  }
  setValueHandler(h: ValueHandler): this {
    this.handlers.value = h;
    return this;
  }
  setValueLabelHandler(h: ValueLabelHandler): this {
    this.handlers.valueLabel = h;
    return this;
  }
  setErrorHandler(h: ErrorHandler): this {
    this.handlers.error = h;
    return this;
  }
  setProgressHandler(h: ProgressHandler): this {
    this.handlers.progress = h;
    return this;
  }

  setFileCharacterEncoding(encoding: string | null): this {
    this.inputEncoding = encoding;
    return this;
  }
  setHandlerCharacterEncoding(encoding: string | null): this {
    this.outputEncoding = encoding;
    return this;
  }
  setRowLimit(limit: number): this {
    this.rowLimit = limit;
    return this;
  }
  setRowOffset(offset: number): this {
    this.rowOffset = offset;
    return this;
  }
  setCodec(codec: Codec): this {
    this.codec = codec;
    return this;
  }
}
