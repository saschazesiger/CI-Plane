/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <PlanCard> (react/plan.js), generated from src/components/plan/. */
import type { BehaviourComponent } from './shared.js';

export type PlanCardVariant = never;

export interface PlanCardEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:decide on the root. */
  onDsDecide?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface PlanCardOptions {
  /** data-ds-plan-state (true: present, false or none: absent). */
  state?: string | number | boolean | object | null;
}

export declare const PlanCard: BehaviourComponent<'section', PlanCardVariant, PlanCardEvents & PlanCardOptions, ReturnType<typeof import('../js/plan.js').create>>;
