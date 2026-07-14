//
// sas/xport-parse-format.ts — parse an XPORT format string
// (port of readstat_xport_parse_format.rl)
//

import { ReadStatError } from "../errors.js";

export interface XportFormat {
  name: string;
  width: number;
  decimals: number;
}

function isAlpha(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}

/** Parse a format like "F8.2", "DATE9", "$CHAR20", "8.2". */
export function xportParseFormat(str: string): { retval: ReadStatError; format: XportFormat } {
  const format: XportFormat = { name: "", width: 0, decimals: 0 };
  let i = 0;
  let name = "";
  if (str[i] === "$") {
    name += "$";
    i++;
  }
  let widthStr = "";
  if (i < str.length && isAlpha(str[i])) {
    let ident = "";
    while (i < str.length && isAlnum(str[i])) {
      ident += str[i];
      i++;
    }
    // trailing digits of the identifier are the width
    let k = ident.length;
    while (k > 0 && isDigit(ident[k - 1])) k--;
    name += ident.slice(0, k);
    widthStr = ident.slice(k);
  } else {
    while (i < str.length && isDigit(str[i])) {
      widthStr += str[i];
      i++;
    }
  }
  if (widthStr) format.width = parseInt(widthStr, 10);

  if (str[i] === ".") {
    i++;
    let dec = "";
    while (i < str.length && isDigit(str[i])) {
      dec += str[i];
      i++;
    }
    if (dec) format.decimals = parseInt(dec, 10);
  }

  format.name = name;
  if (i !== str.length || name.length + 1 > 32) {
    return { retval: ReadStatError.ERROR_BAD_FORMAT_STRING, format };
  }
  return { retval: ReadStatError.OK, format };
}
