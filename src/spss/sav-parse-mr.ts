//
// spss/sav-parse-mr.ts — multiple-response-set parsing
// (port of readstat_sav_parse_mr_name.rl)
//
// The upstream Ragel grammar manipulates the parse pointer by hand inside its
// actions; this is a faithful re-implementation of that field structure. MR
// sets have no writer in ReadStat, so this path is exercised only when reading
// files that define them.
//

import { MrSet } from "../types.js";

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

export type MrDecoder = (bytes: Uint8Array, off: number, len: number) => string;

/** Parse a single MR definition line (without leading '$' / trailing '\n'). */
export function extractMrData(line: Uint8Array, decode: MrDecoder): MrSet | null {
  const len = line.length;
  let p = 0;

  // name = nc+ '='
  const nameStart = 0;
  while (p < len && line[p] !== 0x3d) p++;
  if (p >= len) return null;
  const name = decode(line, nameStart, p - nameStart);
  p++; // consume '='

  if (p >= len) return null;
  // type = 'C' | 'D' | 'E'
  const mrType = String.fromCharCode(line[p]);
  p++; // consume type char

  // counted_value = digit* ' '  ; if n_digits != 0, the counted value is the
  // next n_digits characters (a decimal number)
  let digStart = p;
  while (p < len && isDigit(line[p])) p++;
  const nDigs = parseInt(ascii(line, digStart, p - digStart) || "0", 10) || 0;
  let countedValue = -1;
  if (nDigs !== 0) {
    countedValue = parseInt(ascii(line, p + 1, nDigs), 10);
    p = p + 1 + nDigs;
  }
  p++; // consume the separating space

  // label = digit+ ' '+   ; the label is the next <len> characters
  digStart = p;
  while (p < len && isDigit(line[p])) p++;
  const labelLen = parseInt(ascii(line, digStart, p - digStart) || "0", 10) || 0;
  const label = decode(line, p + 1, labelLen);
  p = p + 1 + labelLen;
  // skip any run of spaces separating the label from the subvariables
  while (p < len && line[p] === 0x20) p++;

  // subvariables — names separated by space or NUL
  const subvariables: string[] = [];
  let subStart = p;
  while (p < len) {
    const c = line[p];
    if (c === 0x20 || c === 0x00) {
      if (p > subStart) subvariables.push(decode(line, subStart, p - subStart));
      p++;
      subStart = p;
    } else {
      p++;
    }
  }
  if (p > subStart) subvariables.push(decode(line, subStart, p - subStart));

  return {
    name,
    label,
    type: mrType,
    countedValue,
    subvariables,
    isDichotomy: mrType === "D",
  };
}

/**
 * Parse a full multiple-response-sets record. Lines start with '$' and end
 * with '\n'; the record ends with a NUL. Returns the parsed sets; on any
 * malformed line the partially parsed set list is returned so that reading the
 * rest of the file is unaffected.
 */
export function parseMrString(data: Uint8Array, decode: MrDecoder): MrSet[] {
  const sets: MrSet[] = [];
  let i = 0;
  const n = data.length;
  while (i < n) {
    if (data[i] !== 0x24 /* $ */) break;
    // find end of line
    let j = i + 1;
    while (j < n && data[j] !== 0x0a /* \n */) j++;
    const line = data.subarray(i + 1, j); // between '$' and '\n'
    const set = extractMrData(line, decode);
    if (set) sets.push(set);
    if (j >= n) break;
    i = j + 1;
    if (i < n && data[i] === 0x00) break;
  }
  return sets;
}
