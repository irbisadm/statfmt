import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, ReadStatError } from "../src/index.js";
import { beginWritingSav } from "../src/spss/sav-write.js";
import { collectingWriter } from "./helpers/collect.js";
import { hasReference, refToCsv, parseCsv, refMetadata, withTmpDir } from "./helpers/reference.js";

function check(code: ReadStatError): void {
  if (code !== ReadStatError.OK) throw new Error(`ReadStat error ${ReadStatError[code]}`);
}

describe.runIf(hasReference())("SAV writer vs reference", () => {
  it("writes a simple uncompressed file the C library can read", () => {
    const { writer, getBytes } = collectingWriter();
    writer.setFileTimestamp(Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000));
    writer.setFileLabel("test file");

    const sex = writer.addLabelSet(ReadStatType.DOUBLE, "sex");
    sex.labelDoubleValue(1, "Male");
    sex.labelDoubleValue(2, "Female");

    const id = writer.addVariable("id", ReadStatType.INT32, 0);
    const score = writer.addVariable("score", ReadStatType.DOUBLE, 0);
    score.setLabel("Test score");
    const grp = writer.addVariable("grp", ReadStatType.INT32, 0);
    writer.setVariableLabelSet(grp, sex);
    const name = writer.addVariable("name", ReadStatType.STRING, 20);

    const rows: [number, number, number, string][] = [
      [1, 3.5, 1, "Alice"],
      [2, 9.25, 2, "Bob"],
      [3, -1.0, 1, "Cörnelius"],
    ];

    check(beginWritingSav(writer, null, rows.length));
    for (const [idv, scorev, grpv, namev] of rows) {
      check(writer.beginRow());
      check(writer.insertInt32Value(id, idv));
      check(writer.insertDoubleValue(score, scorev));
      check(writer.insertInt32Value(grp, grpv));
      check(writer.insertStringValue(name, namev));
      check(writer.endRow());
    }
    check(writer.endWriting());

    const bytes = getBytes();
    expect(bytes.length).toBeGreaterThan(0);

    withTmpDir((dir) => {
      const file = join(dir, "out.sav");
      writeFileSync(file, bytes);

      const meta = refMetadata(file);
      expect(meta).toContain("Columns: 4");

      const { header, rows: csvRows } = parseCsv(refToCsv(file));
      expect(header).toEqual(["id", "score", "grp", "name"]);
      expect(csvRows.length).toBe(3);
      for (let r = 0; r < rows.length; r++) {
        expect(Number(csvRows[r][0])).toBe(rows[r][0]);
        expect(Number(csvRows[r][1])).toBeCloseTo(rows[r][1], 6);
        expect(Number(csvRows[r][2])).toBe(rows[r][2]);
        expect(csvRows[r][3]).toBe(rows[r][3]);
      }
    });
  });
});
