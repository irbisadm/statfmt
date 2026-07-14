import { ReadStatType, ReadStatError, ReadStatMeasure } from "../../src/index.js";
import { beginWritingSav } from "../../src/spss/sav-write.js";
import { collectingWriter } from "./collect.js";

export interface Row {
  id: number;
  score: number | null;
  grp: number;
  name: string;
}

function check(code: ReadStatError): void {
  if (code !== ReadStatError.OK) throw new Error(`ReadStat error ${ReadStatError[code]}`);
}

/** Build a representative SAV file (uncompressed by default) and return its bytes. */
export function buildSampleSav(opts: { compress?: ReadStatError | 0 | 1 | 2; rows?: Row[] } = {}): Uint8Array {
  const { writer, getBytes } = collectingWriter();
  writer.setFileTimestamp(Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000));
  writer.setFileLabel("test file");
  if (opts.compress) writer.setCompression(opts.compress as number);

  const sex = writer.addLabelSet(ReadStatType.DOUBLE, "sex");
  sex.labelDoubleValue(1, "Male");
  sex.labelDoubleValue(2, "Female");

  const id = writer.addVariable("id", ReadStatType.INT32, 0);
  id.setMeasure(ReadStatMeasure.SCALE);
  const score = writer.addVariable("score", ReadStatType.DOUBLE, 0);
  score.setLabel("Test score");
  score.addMissingDoubleValue(-99);
  const grp = writer.addVariable("grp", ReadStatType.INT32, 0);
  grp.setMeasure(ReadStatMeasure.NOMINAL);
  writer.setVariableLabelSet(grp, sex);
  const name = writer.addVariable("name", ReadStatType.STRING, 20);
  name.setLabel("Full name");

  const rows: Row[] =
    opts.rows ??
    [
      { id: 1, score: 3.5, grp: 1, name: "Alice" },
      { id: 2, score: 9.25, grp: 2, name: "Bob" },
      { id: 3, score: null, grp: 1, name: "Cörnelius" },
    ];

  check(beginWritingSav(writer, null, rows.length));
  for (const r of rows) {
    check(writer.beginRow());
    check(writer.insertInt32Value(id, r.id));
    if (r.score === null) check(writer.insertMissingValue(score));
    else check(writer.insertDoubleValue(score, r.score));
    check(writer.insertInt32Value(grp, r.grp));
    check(writer.insertStringValue(name, r.name));
    check(writer.endRow());
  }
  check(writer.endWriting());
  return getBytes();
}
