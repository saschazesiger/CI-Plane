/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Toggle> (react/toggle.js), generated from src/components/toggle/. */
import type { BehaviourComponent } from './shared.js';

export type ToggleVariant = 'adaptive' | 'block' | 'disc' | 'disclosure' | 'elevated' | 'filled' | 'ghost' | 'icon' | 'outlined' | 'quiet' | 'text' | 'tonal';

export interface ToggleEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ToggleOptions {
}

export declare const Toggle: BehaviourComponent<'button', ToggleVariant, ToggleEvents & ToggleOptions, ReturnType<typeof import('../js/toggle.js').create>>;
