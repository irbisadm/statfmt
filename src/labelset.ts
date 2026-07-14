//
// labelset.ts — value label sets (readstat_label_set_t / readstat_value_label_t)
//

import { ReadStatType } from "./types.js";
import type { Variable } from "./variable.js";

export interface ValueLabel {
  doubleKey: number;
  int32Key: number;
  tag: string; // '' if none
  stringKey: string | null;
  label: string;
}

export class LabelSet {
  type: ReadStatType;
  name: string;
  valueLabels: ValueLabel[] = [];
  /** Variables that reference this label set (writer-side bookkeeping). */
  variables: Variable[] = [];

  constructor(type: ReadStatType, name: string) {
    this.type = type;
    this.name = name;
  }

  get valueLabelsCount(): number {
    return this.valueLabels.length;
  }

  private add(partial: Partial<ValueLabel>): ValueLabel {
    const vl: ValueLabel = {
      doubleKey: 0,
      int32Key: 0,
      tag: "",
      stringKey: null,
      label: "",
      ...partial,
    };
    this.valueLabels.push(vl);
    return vl;
  }

  labelDoubleValue(value: number, label: string): void {
    this.add({ doubleKey: value, int32Key: Math.trunc(value) | 0, label });
  }
  labelInt32Value(value: number, label: string): void {
    this.add({ doubleKey: value, int32Key: value | 0, label });
  }
  labelStringValue(value: string, label: string): void {
    this.add({ stringKey: value, label });
  }
  labelTaggedValue(tag: string, label: string): void {
    this.add({ tag, label });
  }
}
