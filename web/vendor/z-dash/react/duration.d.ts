/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <DurationInput> (react/duration.js), generated from src/components/duration/. */
import type { BehaviourComponent } from './shared.js';

export type DurationInputVariant = 'filled' | 'grow' | 'outlined';

export interface DurationInputEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DurationInputOptions {
  /** data-ds-value (true: present, false or none: absent). */
  dsValue?: string | number | boolean | object | null;
  /** data-ds-duration-step (true: present, false or none: absent). */
  dsDurationStep?: string | number | boolean | object | null;
  /** data-ds-duration-min (true: present, false or none: absent). */
  dsDurationMin?: string | number | boolean | object | null;
  /** data-ds-duration-max (true: present, false or none: absent). */
  dsDurationMax?: string | number | boolean | object | null;
  /** data-ds-duration-unit (true: present, false or none: absent). */
  unit?: string | number | boolean | object | null;
  /** data-ds-duration-smallest (true: present, false or none: absent). */
  smallest?: string | number | boolean | object | null;
  /** data-ds-duration-name (true: present, false or none: absent). */
  dsDurationName?: string | number | boolean | object | null;
}

export declare const DurationInput: BehaviourComponent<'input', DurationInputVariant, DurationInputEvents & DurationInputOptions, ReturnType<typeof import('../js/duration.js').create>>;
