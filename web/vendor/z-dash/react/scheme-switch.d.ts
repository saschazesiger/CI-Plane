/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SchemeSwitch> (react/scheme-switch.js), generated from src/components/shell/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type SchemeSwitchVariant = never;

export interface SchemeSwitchEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SchemeSwitchOptions {
}

export declare const SchemeSwitch: BehaviourComponent<'div', SchemeSwitchVariant, SchemeSwitchEvents & SchemeSwitchOptions, Controller>;
