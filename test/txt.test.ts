import { describe, it, expect } from "vitest";
import { ReadStatParser } from "../src/parser.js";
import { BufferIoContext } from "../src/io.js";
import { parseStataDictionary } from "../src/txt/stata-dictionary.js";
import { parseTxt } from "../src/txt/txt-read.js";

// Fixed-width layout: id (cols 1-2), name (cols 3-7), score (cols 8-13)
const DCT = `dictionary {
  _column(1) int id %2f
  _column(3) str5 name %5s
  _column(8) double score %6f
}
`;

// each line is 13 chars wide
const TXT = [" 1Alice   3.5", " 2Bob     9.2", " 3Carol  -1.0", ""].join("\n");

function parseModel(dct: string, txt: string) {
  const parser = new ReadStatParser();
  const variables: { name: string | null; type: number; storageWidth: number }[] = [];
  const rows: (number | string | null)[][] = [];
  parser.setVariableHandler((index, v) => {
    variables[index] = { name: v.getName(), type: v.type, storageWidth: v.storageWidth };
  });
  parser.setValueHandler((obsIndex, v, value) => {
    if (!rows[obsIndex]) rows[obsIndex] = [];
    rows[obsIndex][v.index] = value.toJS();
  });
  const schema = parseStataDictionary(parser, new TextEncoder().encode(dct), null);
  parseTxt(parser, new BufferIoContext(new TextEncoder().encode(txt)), schema, null);
  return { variables, rows };
}

describe("Stata dictionary + fixed-width TXT", () => {
  it("parses the schema and data", () => {
    const { variables, rows } = parseModel(DCT, TXT);
    expect(variables.map((v) => v.name)).toEqual(["id", "name", "score"]);
    expect(variables[1].storageWidth).toBe(5); // str5
    expect(rows[0]).toEqual([1, "Alice", 3.5]);
    expect(rows[1]).toEqual([2, "Bob", 9.2]);
    expect(rows[2]).toEqual([3, "Carol", -1.0]);
  });

  it("handles _newline markers for multi-line observations", () => {
    const dct = `dictionary {
  _lines(2)
  _column(1) int a %2f
  _newline _column(1) int b %2f
}
`;
    const txt = ["10", "20", "30", "40", ""].join("\n");
    const { rows } = parseModel(dct, txt);
    expect(rows[0]).toEqual([10, 20]);
    expect(rows[1]).toEqual([30, 40]);
  });
});
