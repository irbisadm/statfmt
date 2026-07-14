import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, ReadStatError } from "../src/index.js";
import { beginWritingSav } from "../src/spss/sav-write.js";
import { ReadStatParser } from "../src/parser.js";
import { BufferIoContext } from "../src/io.js";
import { parsePor } from "../src/spss/por-read.js";
import { collectingWriter } from "./helpers/collect.js";
import { newModel, wireModel } from "./helpers/model.js";
import { hasReference, refConvert, withTmpDir } from "./helpers/reference.js";

function check(code: ReadStatError): void {
  if (code !== ReadStatError.OK) throw new Error(`ReadStat error ${ReadStatError[code]}`);
}

// POR requires uppercase variable names, so use an uppercase-named source.
function buildUppercaseSav(): Uint8Array {
  const { writer, getBytes } = collectingWriter();
  writer.setFileTimestamp(Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000));
  writer.setFileLabel("por test");
  const sex = writer.addLabelSet(ReadStatType.DOUBLE, "sex");
  sex.labelDoubleValue(1, "Male");
  sex.labelDoubleValue(2, "Female");
  const id = writer.addVariable("ID", ReadStatType.INT32, 0);
  const score = writer.addVariable("SCORE", ReadStatType.DOUBLE, 0);
  score.setLabel("Test score");
  const grp = writer.addVariable("GRP", ReadStatType.INT32, 0);
  writer.setVariableLabelSet(grp, sex);
  const name = writer.addVariable("NAME", ReadStatType.STRING, 16);

  const rows: [number, number, number, string][] = [
    [1, 3.5, 1, "Alice"],
    [2, 9.25, 2, "Bob"],
    [3, -1.0, 1, "Cornelius"],
  ];
  check(beginWritingSav(writer, null, rows.length));
  for (const [a, b, c, d] of rows) {
    check(writer.beginRow());
    check(writer.insertInt32Value(id, a));
    check(writer.insertDoubleValue(score, b));
    check(writer.insertInt32Value(grp, c));
    check(writer.insertStringValue(name, d));
    check(writer.endRow());
  }
  check(writer.endWriting());
  return getBytes();
}

function readPorModel(bytes: Uint8Array) {
  const parser = new ReadStatParser();
  const model = newModel();
  wireModel(parser, model);
  parsePor(parser, new BufferIoContext(bytes), null);
  return model;
}

describe.runIf(hasReference())("POR reader (C-produced files)", () => {
  it("reads a POR converted from a SAV by the C library", () => {
    const sav = buildUppercaseSav();
    withTmpDir((dir) => {
      const savFile = join(dir, "in.sav");
      const porFile = join(dir, "out.por");
      writeFileSync(savFile, sav);
      refConvert(savFile, porFile);

      const model = readPorModel(readFileSync(porFile));
      expect(model.variables.map((v) => v.name)).toEqual(["ID", "SCORE", "GRP", "NAME"]);
      expect(model.rows[0]).toEqual([1, 3.5, 1, "Alice"]);
      expect(model.rows[1]).toEqual([2, 9.25, 2, "Bob"]);
      expect(model.rows[2][0]).toBe(3);
      expect(model.rows[2][3]).toBe("Cornelius");

      const grpLabels = model.valueLabels.get(model.variables[2].valLabelsName!);
      expect(grpLabels?.find((l) => l.value === 1)?.label).toBe("Male");
      expect(grpLabels?.find((l) => l.value === 2)?.label).toBe("Female");
    });
  });
});
