import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatType, ReadStatError } from "../src/index.js";
import { ReadStatParser } from "../src/parser.js";
import { BufferIoContext } from "../src/io.js";
import { beginWritingSas7bcat, parseSas7bcat } from "../src/sas/sas7bcat.js";
import { collectingWriter } from "./helpers/collect.js";
import { hasReference, runReference, withTmpDir } from "./helpers/reference.js";

function buildCatalog(): Uint8Array {
  const { writer, getBytes } = collectingWriter();
  writer.setFileTimestamp(Math.floor(Date.UTC(2021, 0, 15, 10, 30, 0) / 1000));
  const sex = writer.addLabelSet(ReadStatType.DOUBLE, "SEX");
  sex.labelDoubleValue(1, "Male");
  sex.labelDoubleValue(2, "Female");
  sex.labelDoubleValue(-3, "Refused");
  const grade = writer.addLabelSet(ReadStatType.STRING, "$GRADE");
  grade.labelStringValue("A", "Excellent");
  grade.labelStringValue("B", "Good");

  if (beginWritingSas7bcat(writer, null) !== ReadStatError.OK) throw new Error("begin failed");
  if (writer.endWriting() !== ReadStatError.OK) throw new Error("end failed");
  return getBytes();
}

interface Collected {
  labels: Map<string, { value: number | string | null; label: string }[]>;
}

function readCatalog(bytes: Uint8Array): Collected {
  const parser = new ReadStatParser();
  const labels = new Map<string, { value: number | string | null; label: string }[]>();
  parser.setValueLabelHandler((name, value, label) => {
    let arr = labels.get(name);
    if (!arr) labels.set(name, (arr = []));
    arr.push({ value: value.toJS(), label });
  });
  parseSas7bcat(parser, new BufferIoContext(bytes), null);
  return { labels };
}

describe("SAS7BCAT catalog", () => {
  it("round-trips value labels through the TS reader", () => {
    const bytes = buildCatalog();
    const { labels } = readCatalog(bytes);
    expect(labels.get("SEX")).toEqual([
      { value: 1, label: "Male" },
      { value: 2, label: "Female" },
      { value: -3, label: "Refused" },
    ]);
    expect(labels.get("$GRADE")).toEqual([
      { value: "A", label: "Excellent" },
      { value: "B", label: "Good" },
    ]);
  });

  it.runIf(hasReference())("produces a catalog the C library accepts", () => {
    const bytes = buildCatalog();
    withTmpDir((dir) => {
      const file = join(dir, "out.sas7bcat");
      writeFileSync(file, bytes);
      // Metadata dump should succeed without error
      const out = runReference([file]).toString("utf-8");
      expect(out).toContain("SAS");
    });
  });
});
