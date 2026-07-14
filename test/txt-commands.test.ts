import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStatParser } from "../src/parser.js";
import { BufferIoContext } from "../src/io.js";
import { parseSpssCommands } from "../src/txt/spss-commands.js";
import { parseSasCommands } from "../src/txt/sas-commands.js";
import { parseTxt } from "../src/txt/txt-read.js";
import { hasReference, runReference, withTmpDir } from "./helpers/reference.js";

const TXT = [" 1Alice   3.5", " 2Bob     9.2", " 3Carol  -1.0", ""].join("\n");

function parseModel(parseCmd: (parser: ReadStatParser, bytes: Uint8Array, ctx: unknown) => import("../src/txt/schema.js").Schema, cmd: string, txt: string) {
  const parser = new ReadStatParser();
  const variables: { name: string | null; type: number; label: string | null }[] = [];
  const rows: (number | string | null)[][] = [];
  const labels = new Map<string, { value: number | string | null; label: string }[]>();
  parser.setVariableHandler((index, v) => {
    variables[index] = { name: v.getName(), type: v.type, label: v.getLabel() };
  });
  parser.setValueHandler((obsIndex, v, value) => {
    if (!rows[obsIndex]) rows[obsIndex] = [];
    rows[obsIndex][v.index] = value.toJS();
  });
  parser.setValueLabelHandler((name, value, label) => {
    let arr = labels.get(name);
    if (!arr) labels.set(name, (arr = []));
    arr.push({ value: value.toJS(), label });
  });
  const schema = parseCmd(parser, new TextEncoder().encode(cmd), null);
  parseTxt(parser, new BufferIoContext(new TextEncoder().encode(txt)), schema, null);
  return { variables, rows, labels };
}

describe("SPSS DATA LIST", () => {
  const SPS = `DATA LIST FIXED
  / id 1-2 name 3-7 (A) score 8-13.
VARIABLE LABELS id 'Identifier'.
VALUE LABELS id 1 'One' 2 'Two'.
`;
  it("parses schema, labels and reads data", () => {
    const { variables, rows, labels } = parseModel(parseSpssCommands, SPS, TXT);
    expect(variables.map((v) => v.name)).toEqual(["id", "name", "score"]);
    expect(variables[0].label).toBe("Identifier");
    expect(rows[0]).toEqual([1, "Alice", 3.5]);
    expect(rows[2]).toEqual([3, "Carol", -1.0]);
    expect(labels.get("labels0")).toEqual([
      { value: 1, label: "One" },
      { value: 2, label: "Two" },
    ]);
  });

  it.runIf(hasReference())("C library accepts the .sps schema", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "d.txt"), TXT);
      writeFileSync(join(dir, "s.sps"), SPS);
      const out = runReference([join(dir, "d.txt"), join(dir, "s.sps"), "-"]).toString("utf-8");
      expect(out).toContain("Alice");
      expect(out).toContain("Carol");
    });
  });
});

describe("SAS INPUT", () => {
  const SAS = `INPUT id 1-2 name $ 3-7 score 8-13;
LABEL id = 'Identifier';
`;
  it("parses schema and reads data", () => {
    const { variables, rows } = parseModel(parseSasCommands, SAS, TXT);
    expect(variables.map((v) => v.name)).toEqual(["id", "name", "score"]);
    expect(variables[0].label).toBe("Identifier");
    expect(rows[0]).toEqual([1, "Alice", 3.5]);
    expect(rows[2]).toEqual([3, "Carol", -1.0]);
  });
});
