/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <TypeConfirm> (react/typeconfirm.js), generated from src/components/typeconfirm/. */
import type { BehaviourComponent } from './shared.js';

export type TypeConfirmVariant = 'modeless';

export interface TypeConfirmEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:confirm on the root. */
  onDsConfirm?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TypeConfirmOptions {
  /** data-ds-typeconfirm-case (true: present, false or none: absent). */
  case?: string | number | boolean | object | null;
}

export declare const TypeConfirm: BehaviourComponent<'form', TypeConfirmVariant, TypeConfirmEvents & TypeConfirmOptions, ReturnType<typeof import('../js/typeconfirm.js').create>>;
