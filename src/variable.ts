//
// variable.ts — readstat_variable_t + missingness (port of readstat_variable.c)
//

import { ReadStatType, ReadStatTypeClass, ReadStatMeasure, ReadStatAlignment, readstatTypeClass } from "./types.js";
import {
  ReadStatValue,
  makeBlankValue,
  makeDoubleValue,
  makeStringValue,
} from "./value.js";
import { ReadStatError } from "./errors.js";
import type { LabelSet } from "./labelset.js";

const MAX_MISSING_RANGES = 16; // missing_ranges[32] -> 16 lo/hi pairs

export interface Missingness {
  /** Flat array: [lo0, hi0, lo1, hi1, ...]. */
  ranges: ReadStatValue[];
  count: number;
}

export class Variable {
  type: ReadStatType;
  index: number;
  name = "";
  format = "";
  label = "";
  labelSet: LabelSet | null = null;
  offset = 0;
  storageWidth = 0;
  userWidth = 0;
  missingness: Missingness = { ranges: [], count: 0 };
  measure: ReadStatMeasure = ReadStatMeasure.UNKNOWN;
  alignment: ReadStatAlignment = ReadStatAlignment.UNKNOWN;
  displayWidth = 0;
  decimals = 0;
  skip = 0;
  indexAfterSkipping = 0;

  constructor(type: ReadStatType, index: number, storageWidth = 0) {
    this.type = type;
    this.index = index;
    this.storageWidth = storageWidth;
  }

  getTypeClass(): ReadStatTypeClass {
    return readstatTypeClass(this.type);
  }

  getName(): string | null {
    return this.name.length ? this.name : null;
  }
  getLabel(): string | null {
    return this.label.length ? this.label : null;
  }
  getFormat(): string | null {
    return this.format.length ? this.format : null;
  }

  getMissingRangesCount(): number {
    return this.missingness.count;
  }
  getMissingRangeLo(i: number): ReadStatValue {
    if (i < this.missingness.count && 2 * i + 1 < 32) {
      return this.missingness.ranges[2 * i];
    }
    return makeBlankValue();
  }
  getMissingRangeHi(i: number): ReadStatValue {
    if (i < this.missingness.count && 2 * i + 1 < 32) {
      return this.missingness.ranges[2 * i + 1];
    }
    return makeBlankValue();
  }

  private addMissingValueRange(lo: ReadStatValue, hi: ReadStatValue): ReadStatError {
    const i = this.missingness.count;
    if (i < MAX_MISSING_RANGES) {
      this.missingness.ranges[2 * i] = lo;
      this.missingness.ranges[2 * i + 1] = hi;
      this.missingness.count++;
      return ReadStatError.OK;
    }
    return ReadStatError.ERROR_TOO_MANY_MISSING_VALUE_DEFINITIONS;
  }

  addMissingDoubleValue(value: number): ReadStatError {
    return this.addMissingValueRange(makeDoubleValue(value), makeDoubleValue(value));
  }
  addMissingDoubleRange(lo: number, hi: number): ReadStatError {
    return this.addMissingValueRange(makeDoubleValue(lo), makeDoubleValue(hi));
  }
  addMissingStringValue(value: string): ReadStatError {
    return this.addMissingValueRange(makeStringValue(value), makeStringValue(value));
  }
  addMissingStringRange(lo: string, hi: string): ReadStatError {
    return this.addMissingValueRange(makeStringValue(lo), makeStringValue(hi));
  }

  // Setters (writer API)
  setLabel(label: string): void {
    this.label = label;
  }
  setFormat(format: string): void {
    this.format = format;
  }
  setMeasure(measure: ReadStatMeasure): void {
    this.measure = measure;
  }
  setAlignment(alignment: ReadStatAlignment): void {
    this.alignment = alignment;
  }
  setDisplayWidth(width: number): void {
    this.displayWidth = width;
  }
}

// ---- Missing-value checks that require both a value and its variable ----

function doubleIsDefinedMissing(fp: number, variable: Variable): boolean {
  const count = variable.getMissingRangesCount();
  for (let i = 0; i < count; i++) {
    const lo = variable.getMissingRangeLo(i).doubleValue();
    const hi = variable.getMissingRangeHi(i).doubleValue();
    if (fp >= lo && fp <= hi) return true;
  }
  return false;
}

function stringIsDefinedMissing(s: string | null, variable: Variable): boolean {
  if (s === null) return false;
  const count = variable.getMissingRangesCount();
  for (let i = 0; i < count; i++) {
    const lo = variable.getMissingRangeLo(i).stringValue();
    const hi = variable.getMissingRangeHi(i).stringValue();
    if (lo !== null && hi !== null && s >= lo && s <= hi) return true;
  }
  return false;
}

export function valueIsDefinedMissing(value: ReadStatValue, variable: Variable): boolean {
  if (value.typeClass() !== variable.getTypeClass()) return false;
  if (value.typeClass() === ReadStatTypeClass.STRING) {
    return stringIsDefinedMissing(value.stringValue(), variable);
  }
  return doubleIsDefinedMissing(value.doubleValue(), variable);
}

export function valueIsMissing(value: ReadStatValue, variable: Variable | null): boolean {
  if (value.isSystemMissing || value.isTaggedMissing) return true;
  if (variable) return valueIsDefinedMissing(value, variable);
  return false;
}
