/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <LabelGroup> (react/labelgroup.js), generated from src/components/labelgroup/. */
import type { BehaviourComponent } from './shared.js';

export type LabelGroupVariant = never;

export interface LabelGroupEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LabelGroupOptions {
  /** data-ds-label-group-max (true: present, false or none: absent). */
  dsLabelGroupMax?: string | number | boolean | object | null;
}

export declare const LabelGroup: BehaviourComponent<'div', LabelGroupVariant, LabelGroupEvents & LabelGroupOptions, ReturnType<typeof import('../js/labelgroup.js').create>>;
