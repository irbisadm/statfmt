//
// stata/dta-parse-timestamp.ts — parse DTA timestamp strings
// (port of readstat_dta_parse_timestamp.rl)
//

import { ReadStatError } from "../errors.js";
import { Tm } from "../spss/sav-parse-timestamp.js";

const MONTHS: Record<string, number> = {
  JAN: 0, ENE: 0, FEB: 1, MAR: 2, APR: 3, ABR: 3, MAY: 4, MAI: 4,
  JUN: 5, JUL: 6, AUG: 7, AGO: 7, SEP: 8, OCT: 9, OKT: 9, NOV: 10,
  DEC: 11, DEZ: 11, DIC: 11,
};

/** Parse "DD Mon YYYY HH:MM" (with locale month variants) into `timestamp`. */
export function dtaParseTimestamp(data: string, timestamp: Tm): ReadStatError {
  // main := " "? day " " month " " year " "+ hour ":" minute
  const m = /^ ?(\d+) ([A-Za-z]{3}) (\d+) +(\d+):(\d+)$/.exec(data);
  if (!m) return ReadStatError.ERROR_BAD_TIMESTAMP_STRING;
  const mon = MONTHS[m[2].toUpperCase()];
  if (mon === undefined) return ReadStatError.ERROR_BAD_TIMESTAMP_STRING;
  timestamp.tm_mday = parseInt(m[1], 10);
  timestamp.tm_mon = mon;
  timestamp.tm_year = parseInt(m[3], 10) - 1900;
  timestamp.tm_hour = parseInt(m[4], 10);
  timestamp.tm_min = parseInt(m[5], 10);
  timestamp.tm_sec = 0;
  return ReadStatError.OK;
}

/** Format a timestamp as Stata's "DD Mon YYYY HH:MM". */
export function dtaFormatTimestamp(tm: Tm): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${pad(tm.tm_mday)} ${months[tm.tm_mon]} ${tm.tm_year + 1900} ${pad(tm.tm_hour)}:${pad(tm.tm_min)}`;
}
