/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <CodeField> (react/otp.js), generated from src/components/otp/. */
import type { BehaviourComponent } from './shared.js';

export type CodeFieldVariant = never;

export interface CodeFieldEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:complete on the root. */
  onDsComplete?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface CodeFieldOptions {
  /** data-ds-otp-type (true: present, false or none: absent). */
  dsOtpType?: string | number | boolean | object | null;
  /** data-ds-otp-mask (true: present, false or none: absent). */
  mask?: string | number | boolean | object | null;
}

export declare const CodeField: BehaviourComponent<'div', CodeFieldVariant, CodeFieldEvents & CodeFieldOptions, ReturnType<typeof import('../js/otp.js').create>>;
