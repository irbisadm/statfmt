//
// spss/por.ts — SPSS portable (.por) shared helpers: charset tables and
// base-30 number parsing (port of readstat_por.c and readstat_por_parse.rl)
//

export const POR_LINE_LENGTH = 80;

// Canonical character -> ASCII value (0 = undefined). Index is the "canonical"
// slot; the file's reverse_lookup maps a real byte to a canonical slot.
export const POR_ASCII_LOOKUP: number[] = buildAscii();
export const POR_UNICODE_LOOKUP: number[] = buildUnicode();

function buildAscii(): number[] {
  const a = new Array(256).fill(0);
  const set = (i: number, s: string) => (a[i] = s.charCodeAt(0));
  // digits 0-9 at 64..73
  for (let d = 0; d < 10; d++) a[64 + d] = 0x30 + d;
  // A-Z at 74..99
  for (let d = 0; d < 26; d++) a[74 + d] = 0x41 + d;
  // a-z at 100..125
  for (let d = 0; d < 26; d++) a[100 + d] = 0x61 + d;
  set(126, " ");
  set(127, ".");
  set(128, "<");
  set(129, "(");
  set(130, "+");
  set(131, "|");
  set(132, "&");
  set(133, "[");
  set(134, "]");
  set(135, "!");
  set(136, "$");
  set(137, "*");
  set(138, ")");
  set(139, ";");
  set(140, "^");
  set(141, "-");
  set(142, "/");
  set(143, "|");
  set(144, ",");
  set(145, "%");
  set(146, "_");
  set(147, ">");
  set(148, "?");
  set(149, "`");
  set(150, ":");
  set(151, "#");
  set(152, "@");
  set(153, "'");
  set(154, "=");
  set(155, '"');
  set(162, "~");
  set(184, "{");
  set(185, "}");
  set(186, "\\");
  return a;
}

function buildUnicode(): number[] {
  const u = POR_ASCII_LOOKUP.slice();
  // override with the Unicode-specific code points
  u[143] = 0x00a3;
  u[149] = 0x2018;
  u[151] = 0x00a6;
  u[153] = 0x2019;
  u[156] = 0x2264;
  u[157] = 0x25a1;
  u[158] = 0x00b1;
  u[159] = 0x25a0;
  u[160] = 0x00b0;
  u[161] = 0x2020;
  u[163] = 0x2013;
  u[164] = 0x2514;
  u[165] = 0x250c;
  u[166] = 0x2265;
  u[167] = 0x2070;
  u[168] = 0x2071;
  u[169] = 0x00b2;
  u[170] = 0x00b3;
  u[171] = 0x2074;
  u[172] = 0x2075;
  u[173] = 0x2076;
  u[174] = 0x2077;
  u[175] = 0x2078;
  u[176] = 0x2079;
  u[177] = 0x2518;
  u[178] = 0x2510;
  u[179] = 0x2260;
  u[180] = 0x2014;
  u[181] = 0x207d;
  u[182] = 0x207e;
  u[183] = 0x2e38;
  u[187] = 0x00a2;
  u[188] = 0x2022;
  return u;
}

/** Combined lookup used for reading: prefer the ASCII value, else Unicode. */
export const POR_COMBINED_LOOKUP: number[] = (() => {
  const c = new Array(256).fill(0);
  for (let i = 0; i < 256; i++) c[i] = POR_ASCII_LOOKUP[i] || POR_UNICODE_LOOKUP[i];
  return c;
})();

/** Decode POR file bytes into a JS string via a byte->codepoint table. */
export function porDecode(bytes: Uint8Array, len: number, byte2unicode: number[]): string | null {
  let out = "";
  for (let i = 0; i < len; i++) {
    let cp = byte2unicode[bytes[i]];
    if (cp === 0) cp = 0xfffd;
    if (cp < 0x20) return null;
    out += String.fromCodePoint(cp);
  }
  return out;
}

function base30Digit(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 0x30;
  if (c >= "A" && c <= "T") return 10 + c.charCodeAt(0) - 0x41;
  return -1;
}

export interface PorDoubleResult {
  value: number;
  consumed: number;
}

/**
 * Parse a base-30 encoded double (port of readstat_por_parse_double).
 * Returns null on parse failure.
 */
export function porParseDouble(s: string): PorDoubleResult | null {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;

  if (s[i] === "*" && s[i + 1] === ".") {
    return { value: NaN, consumed: i + 2 };
  }

  let isNegative = false;
  if (s[i] === "-") {
    isNegative = true;
    i++;
  }

  let num = 0;
  let tempFrac = 0;
  let exp = 0;
  let expNegative = false;

  const parseValue = (): number => {
    let v = 0;
    let n = 0;
    while (i < s.length) {
      const d = base30Digit(s[i]);
      if (d < 0) break;
      v = 30 * v + d;
      i++;
      n++;
    }
    return n > 0 ? v : NaN;
  };
  const parseFraction = (): void => {
    // assumes s[i] === '.'
    i++; // consume '.'
    let denom = 30;
    while (i < s.length) {
      const d = base30Digit(s[i]);
      if (d < 0) break;
      tempFrac += d / denom;
      denom *= 30;
      i++;
    }
  };

  if (s[i] === ".") {
    // nonmissing_fraction
    parseFraction();
    if (s[i] !== "/") return null;
    i++;
  } else {
    // nonmissing_value
    const v = parseValue();
    if (Number.isNaN(v)) return null;
    num = v;
    if (s[i] === ".") parseFraction();
    if (s[i] === "+" || s[i] === "-") {
      expNegative = s[i] === "-";
      i++;
      const e = parseValue();
      if (Number.isNaN(e)) return null;
      exp = e;
    }
    if (s[i] !== "/") return null;
    i++;
  }

  let val = num + tempFrac;
  if (expNegative) exp = -exp;
  if (exp) val *= Math.pow(30, exp);
  if (isNegative) val = -val;

  return { value: val, consumed: i };
}
