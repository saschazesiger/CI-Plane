/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SplitButton> (react/splitbutton.js), generated from src/components/splitbutton/. */
import type { BehaviourComponent } from './shared.js';

export type SplitButtonVariant = 'block';

export interface SplitButtonEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SplitButtonOptions {
  /** data-ds-value (true: present, false or none: absent). */
  dsValue?: string | number | boolean | object | null;
}

export declare const SplitButton: BehaviourComponent<'div', SplitButtonVariant, SplitButtonEvents & SplitButtonOptions, ReturnType<typeof import('../js/splitbutton.js').create>>;
