//
// spss/sav-parse-timestamp.ts — parse SAV header date/time strings
// (port of readstat_sav_parse_timestamp.rl)
//

import { ReadStatError } from "../errors.js";

export interface Tm {
  tm_year: number; // years since 1900
  tm_mon: number; // 0-11
  tm_mday: number;
  tm_hour: number;
  tm_min: number;
  tm_sec: number;
}

export function makeTm(): Tm {
  return { tm_year: 0, tm_mon: 0, tm_mday: 0, tm_hour: 0, tm_min: 0, tm_sec: 0 };
}

/** Parse a 2-char field where the first char may be a space (padding) or digit. */
function parseInteger2(data: string, pos: number): number | null {
  const a = data[pos];
  const b = data[pos + 1];
  if (b === undefined || b < "0" || b > "9") return null;
  const bv = b.charCodeAt(0) - 48;
  if (a === " ") return bv;
  if (a >= "0" && a <= "9") return (a.charCodeAt(0) - 48) * 10 + bv;
  return null;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Parse "HH:MM:SS" into timestamp. */
export function savParseTime(data: string, timestamp: Tm): ReadStatError {
  if (data.length !== 8 || data[2] !== ":" || data[5] !== ":") {
    return ReadStatError.ERROR_BAD_TIMESTAMP_STRING;
  }
  const h = parseInteger2(data, 0);
  const m = parseInteger2(data, 3);
  const s = parseInteger2(data, 6);
  if (h === null || m === null || s === null) return ReadStatError.ERROR_BAD_TIMESTAMP_STRING;
  timestamp.tm_hour = h;
  timestamp.tm_min = m;
  timestamp.tm_sec = s;
  return ReadStatError.OK;
}

/** Parse "DD-MMM-YY[YY]" (dash or space separators) into timestamp. */
export function savParseDate(data: string, timestamp: Tm): ReadStatError {
  // main := day [ \-] month [ \-] year   (day/year are 2-char, month is 3-char)
  const m = /^([0-9 ]{2})[ \-]([A-Za-z]{3})[ \-]([0-9 ]{2})$/.exec(data);
  if (!m) return ReadStatError.ERROR_BAD_TIMESTAMP_STRING;
  const day = parseInteger2(m[1], 0);
  const mon = MONTHS[m[2].toUpperCase()];
  const year = parseInteger2(m[3], 0);
  if (day === null || mon === undefined || year === null) {
    return ReadStatError.ERROR_BAD_TIMESTAMP_STRING;
  }
  timestamp.tm_mday = day;
  timestamp.tm_mon = mon;
  timestamp.tm_year = year < 70 ? 100 + year : year;
  return ReadStatError.OK;
}

/** Convert a struct-tm (UTC) to seconds since the Unix epoch (like timegm). */
export function tmToEpoch(tm: Tm): number {
  return Math.floor(
    Date.UTC(tm.tm_year + 1900, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec) / 1000,
  );
}

/** Convert seconds since epoch to a struct-tm (UTC). */
export function epochToTm(epoch: number): Tm {
  const d = new Date(epoch * 1000);
  return {
    tm_year: d.getUTCFullYear() - 1900,
    tm_mon: d.getUTCMonth(),
    tm_mday: d.getUTCDate(),
    tm_hour: d.getUTCHours(),
    tm_min: d.getUTCMinutes(),
    tm_sec: d.getUTCSeconds(),
  };
}
