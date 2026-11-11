/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Password> (react/password.js), generated from src/components/password/. */
import type { BehaviourComponent } from './shared.js';

export type PasswordVariant = 'changed' | 'filled' | 'full' | 'grow' | 'inset' | 'outlined' | 'success' | 'warning';

export interface PasswordEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:reveal on the root. */
  onDsReveal?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface PasswordOptions {
  /** data-ds-password-min (true: present, false or none: absent). */
  dsPasswordMin?: string | number | boolean | object | null;
}

export declare const Password: BehaviourComponent<'div', PasswordVariant, PasswordEvents & PasswordOptions, ReturnType<typeof import('../js/password.js').create>>;
