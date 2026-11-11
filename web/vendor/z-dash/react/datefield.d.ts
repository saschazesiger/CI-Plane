/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <DateField> (react/datefield.js), generated from src/components/datefield/. */
import type { BehaviourComponent } from './shared.js';

export type DateFieldVariant = 'block' | 'filled' | 'outlined';

export interface DateFieldEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DateFieldOptions {
  /** data-ds-value (true: present, false or none: absent). */
  dsValue?: string | number | boolean | object | null;
  /** data-ds-datefield-type (true: present, false or none: absent). */
  dsDatefieldType?: string | number | boolean | object | null;
  /** data-ds-datefield-min (true: present, false or none: absent). */
  dsDatefieldMin?: string | number | boolean | object | null;
  /** data-ds-datefield-max (true: present, false or none: absent). */
  dsDatefieldMax?: string | number | boolean | object | null;
  /** data-ds-datefield-seconds (true: present, false or none: absent). */
  seconds?: string | number | boolean | object | null;
  /** data-ds-datefield-hour-cycle (true: present, false or none: absent). */
  hourCycle?: string | number | boolean | object | null;
  /** data-ds-datefield-zone (true: present, false or none: absent). */
  zone?: string | number | boolean | object | null;
  /** data-ds-datefield-name (true: present, false or none: absent). */
  dsDatefieldName?: string | number | boolean | object | null;
}

export declare const DateField: BehaviourComponent<'div', DateFieldVariant, DateFieldEvents & DateFieldOptions, ReturnType<typeof import('../js/datefield.js').create>>;
