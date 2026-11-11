/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <NumberInput> (react/number.js), generated from src/components/number/. */
import type { BehaviourComponent } from './shared.js';

export type NumberInputVariant = 'split';

export interface NumberInputEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface NumberInputOptions {
  /** data-ds-number-min (true: present, false or none: absent). */
  dsNumberMin?: string | number | boolean | object | null;
  /** data-ds-number-max (true: present, false or none: absent). */
  dsNumberMax?: string | number | boolean | object | null;
  /** data-ds-number-step (true: present, false or none: absent). */
  dsNumberStep?: string | number | boolean | object | null;
  /** data-ds-number-page (true: present, false or none: absent). */
  page?: string | number | boolean | object | null;
  /** data-ds-number-decimals (true: present, false or none: absent). */
  decimals?: string | number | boolean | object | null;
  /** data-ds-number-currency (true: present, false or none: absent). */
  currency?: string | number | boolean | object | null;
  /** data-ds-number-unit (true: present, false or none: absent). */
  unit?: string | number | boolean | object | null;
  /** data-ds-number-grouping (true: present, false or none: absent). */
  grouping?: string | number | boolean | object | null;
}

export declare const NumberInput: BehaviourComponent<'div', NumberInputVariant, NumberInputEvents & NumberInputOptions, ReturnType<typeof import('../js/number.js').create>>;
