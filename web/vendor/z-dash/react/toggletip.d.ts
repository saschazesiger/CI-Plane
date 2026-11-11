/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Toggletip> (react/toggletip.js), generated from src/components/toggletip/. */
import type { BehaviourComponent } from './shared.js';

export type ToggletipVariant = never;

export interface ToggletipEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ToggletipOptions {
  /** data-ds-toggletip-placement (true: present, false or none: absent). */
  placement?: string | number | boolean | object | null;
}

export declare const Toggletip: BehaviourComponent<'button', ToggletipVariant, ToggletipEvents & ToggletipOptions, ReturnType<typeof import('../js/toggletip.js').create>>;
