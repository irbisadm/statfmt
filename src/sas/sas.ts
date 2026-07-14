//
// sas/sas.ts — shared SAS constants and validation (subset of readstat_sas.c)
//

import { ReadStatError } from "../errors.js";

export const SAS_COLUMN_TYPE_NUM = 0x01;
export const SAS_COLUMN_TYPE_CHR = 0x02;

export const XPORT_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const RESERVED = new Set(["_N_", "_ERROR_", "_NUMERIC_", "_CHARACTER_", "_ALL_"]);

export function sasValidateName(name: string, maxLen: number): ReadStatError {
  for (let j = 0; j < name.length; j++) {
    const c = name[j];
    if (c !== "_" && !(c >= "a" && c <= "z") && !(c >= "A" && c <= "Z") && !(c >= "0" && c <= "9")) {
      return ReadStatError.ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER;
    }
  }
  if (name.length === 0) return ReadStatError.ERROR_NAME_IS_ZERO_LENGTH;
  const first = name[0];
  if (first !== "_" && !(first >= "a" && first <= "z") && !(first >= "A" && first <= "Z")) {
    return ReadStatError.ERROR_NAME_BEGINS_WITH_ILLEGAL_CHARACTER;
  }
  if (RESERVED.has(name)) return ReadStatError.ERROR_NAME_IS_RESERVED_WORD;
  if (name.length > maxLen) return ReadStatError.ERROR_NAME_IS_TOO_LONG;
  return ReadStatError.OK;
}

export function sasValidateVariableName(name: string): ReadStatError {
  return sasValidateName(name, 32);
}

/** SAS special-missing tag validity: '_' or 'A'-'Z'. */
export function sasValidateTag(tag: number): ReadStatError {
  if (tag === 0x5f || (tag >= 0x41 && tag <= 0x5a)) return ReadStatError.OK;
  return ReadStatError.ERROR_TAGGED_VALUE_IS_OUT_OF_RANGE;
}
