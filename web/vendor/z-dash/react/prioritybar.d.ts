/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <PriorityBar> (react/prioritybar.js), generated from src/components/prioritybar/. */
import type { BehaviourComponent } from './shared.js';

export type PriorityBarVariant = 'end';

export interface PriorityBarEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface PriorityBarOptions {
}

export declare const PriorityBar: BehaviourComponent<'div', PriorityBarVariant, PriorityBarEvents & PriorityBarOptions, ReturnType<typeof import('../js/prioritybar.js').create>>;
