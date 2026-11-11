/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Counter> (react/counter.js), generated from src/components/form/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type CounterVariant = 'filled' | 'grow' | 'outlined';

export interface CounterEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface CounterOptions {
  /** data-ds-counter-max (true: present, false or none: absent). */
  dsCounterMax?: string | number | boolean | object | null;
  /** data-ds-counter-warn (true: present, false or none: absent). */
  warn?: string | number | boolean | object | null;
}

export declare const Counter: BehaviourComponent<'textarea', CounterVariant, CounterEvents & CounterOptions, Controller>;
