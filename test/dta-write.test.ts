import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, ReadStatError } from "../src/index.js";
import { beginWritingDta } from "../src/stata/dta-write.js";
import { parseDta } from "../src/stata/dta-read.js";
import { ReadStatParser } from "../src/parser.js";
import { BufferIoContext } from "../src/io.js";
import { collectingWriter } from "./helpers/collect.js";
import { newModel, wireModel } from "./helpers/model.js";
import { hasReference, refToCsv, parseCsv, withTmpDir } from "./helpers/reference.js";

function check(code: ReadStatError): void {
  if (code !== ReadStatError.OK) throw new Error(`ReadStat error ${ReadStatError[code]}`);
}

function buildDta(version = 118, thirdName = "Carol"): Uint8Array {
  const { writer, getBytes } = collectingWriter();
  writer.setFileTimestamp(Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000));
  writer.setFileLabel("stata test");
  writer.setFileFormatVersion(version);

  const sex = writer.addLabelSet(ReadStatType.INT32, "sexlbl");
  sex.labelInt32Value(1, "Male");
  sex.labelInt32Value(2, "Female");

  const id = writer.addVariable("id", ReadStatType.INT32, 0);
  const score = writer.addVariable("score", ReadStatType.DOUBLE, 0);
  score.setLabel("Test score");
  const grp = writer.addVariable("grp", ReadStatType.INT8, 0);
  writer.setVariableLabelSet(grp, sex);
  const name = writer.addVariable("name", ReadStatType.STRING, 16);

  const rows: [number, number | null, number, string][] = [
    [1, 3.5, 1, "Alice"],
    [2, 9.25, 2, "Bob"],
    [3, null, 1, thirdName],
  ];

  check(beginWritingDta(writer, null, rows.length));
  for (const [idv, scorev, grpv, namev] of rows) {
    check(writer.beginRow());
    check(writer.insertInt32Value(id, idv));
    if (scorev === null) check(writer.insertMissingValue(score));
    else check(writer.insertDoubleValue(score, scorev));
    check(writer.insertInt8Value(grp, grpv));
    check(writer.insertStringValue(name, namev));
    check(writer.endRow());
  }
  check(writer.endWriting());
  return getBytes();
}

function readDta(bytes: Uint8Array) {
  const parser = new ReadStatParser();
  const model = newModel();
  wireModel(parser, model);
  parseDta(parser, new BufferIoContext(bytes), null);
  return model;
}

for (const version of [118, 117, 114, 108]) {
  describe(`DTA writer v${version}`, () => {
    it("round-trips through the TS reader", () => {
      const bytes = buildDta(version);
      const model = readDta(bytes);
      expect(model.metadata?.fileFormatVersion).toBe(version);
      expect(model.variables.map((v) => v.name)).toEqual(["id", "score", "grp", "name"]);
      expect(model.rows[0]).toEqual([1, 3.5, 1, "Alice"]);
      expect(model.rows[1]).toEqual([2, 9.25, 2, "Bob"]);
      expect(model.rows[2][0]).toBe(3);
      expect(model.rows[2][1]).toBe(null);
      expect(model.rows[2][3]).toBe("Carol");
    });

    it.runIf(hasReference())("is readable by the C library", () => {
      const bytes = buildDta(version);
      withTmpDir((dir) => {
        const file = join(dir, "out.dta");
        writeFileSync(file, bytes);
        const { header, rows } = parseCsv(refToCsv(file));
        expect(header).toEqual(["id", "score", "grp", "name"]);
        expect(rows.length).toBe(3);
        expect(Number(rows[0][0])).toBe(1);
        expect(Number(rows[1][1])).toBeCloseTo(9.25, 4);
        expect(rows[2][3]).toBe("Carol");
      });
    });
  });
}

describe("DTA writer v118 UTF-8", () => {
  it("round-trips non-ASCII strings (UTF-8 native)", () => {
    const bytes = buildDta(118, "Cörnelius");
    const model = readDta(bytes);
    expect(model.rows[2][3]).toBe("Cörnelius");
  });

  it.runIf(hasReference())("C library reads UTF-8 correctly", () => {
    const bytes = buildDta(118, "Cörnelius");
    withTmpDir((dir) => {
      const file = join(dir, "out.dta");
      writeFileSync(file, bytes);
      const { rows } = parseCsv(refToCsv(file));
      expect(rows[2][3]).toBe("Cörnelius");
    });
  });
});
