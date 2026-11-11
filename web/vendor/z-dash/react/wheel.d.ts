/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Wheel> (react/wheel.js), generated from src/components/wheel/. */
import type { BehaviourComponent } from './shared.js';

export type WheelVariant = never;

export interface WheelEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface WheelOptions {
  /** data-ds-wheel-shimmer (true: present, false or none: absent). */
  shimmer?: string | number | boolean | object | null;
}

export declare const Wheel: BehaviourComponent<'span', WheelVariant, WheelEvents & WheelOptions, ReturnType<typeof import('../js/wheel.js').create>>;
