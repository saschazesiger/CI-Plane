/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Reasoning> (react/reasoning.js), generated from src/components/reasoning/. */
import type { BehaviourComponent } from './shared.js';

export type ReasoningVariant = 'row';

export interface ReasoningEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ReasoningOptions {
  /** data-ds-reasoning-since (true: present, false or none: absent). */
  since?: string | number | boolean | object | null;
  /** data-ds-reasoning-done (true: present, false or none: absent). */
  done?: string | number | boolean | object | null;
  /** data-ds-reasoning-auto (true: present, false or none: absent). */
  auto?: string | number | boolean | object | null;
}

export declare const Reasoning: BehaviourComponent<'details', ReasoningVariant, ReasoningEvents & ReasoningOptions, ReturnType<typeof import('../js/reasoning.js').create>>;
