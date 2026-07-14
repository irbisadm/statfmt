import { ReadStatParser } from "../../src/parser.js";
import { BufferIoContext } from "../../src/io.js";
import { ReadStatMetadata } from "../../src/types.js";
import { parseSav } from "../../src/spss/sav-read.js";

export interface VarModel {
  index: number;
  name: string | null;
  type: number;
  format: string | null;
  label: string | null;
  measure: number;
  alignment: number;
  displayWidth: number;
  storageWidth: number;
  valLabelsName: string | null;
  missingRanges: { lo: number | string | null; hi: number | string | null }[];
}

export interface DataModel {
  metadata: ReadStatMetadata | null;
  variables: VarModel[];
  rows: (number | string | null)[][];
  valueLabels: Map<string, { value: number | string | null; label: string }[]>;
  notes: string[];
}

export function newModel(): DataModel {
  return { metadata: null, variables: [], rows: [], valueLabels: new Map(), notes: [] };
}

/** Wire a parser's handlers to accumulate a DataModel. */
export function wireModel(parser: ReadStatParser, model: DataModel): void {
  parser.setMetadataHandler((m) => {
    model.metadata = m;
  });
  parser.setNoteHandler((_i, note) => {
    model.notes.push(note);
  });
  parser.setVariableHandler((index, v, valLabels) => {
    const missingRanges = [];
    for (let i = 0; i < v.getMissingRangesCount(); i++) {
      const lo = v.getMissingRangeLo(i);
      const hi = v.getMissingRangeHi(i);
      missingRanges.push({ lo: lo.toJS(), hi: hi.toJS() });
    }
    model.variables[index] = {
      index,
      name: v.getName(),
      type: v.type,
      format: v.getFormat(),
      label: v.getLabel(),
      measure: v.measure,
      alignment: v.alignment,
      displayWidth: v.displayWidth,
      storageWidth: v.storageWidth,
      valLabelsName: valLabels,
      missingRanges,
    };
  });
  parser.setValueHandler((obsIndex, v, value) => {
    if (!model.rows[obsIndex]) model.rows[obsIndex] = [];
    model.rows[obsIndex][v.index] = value.toJS();
  });
  parser.setValueLabelHandler((name, value, label) => {
    let arr = model.valueLabels.get(name);
    if (!arr) {
      arr = [];
      model.valueLabels.set(name, arr);
    }
    arr.push({ value: value.toJS(), label });
  });
}

export function readSavModel(bytes: Uint8Array): DataModel {
  const parser = new ReadStatParser();
  const model = newModel();
  wireModel(parser, model);
  const io = new BufferIoContext(bytes);
  parseSav(parser, io, null);
  return model;
}
