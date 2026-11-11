/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.plan (src/components/plan/plan.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type PlanStateName = 'waiting' | 'approved' | 'rejected';

export interface PlanChange {
  state: PlanStateName;
}

export interface PlanDecide {
  /** What the pressed action asks for; preventDefault() on ds:decide keeps the plan waiting. */
  decision: 'approved' | 'rejected';
}

export interface PlanController {
  get(): PlanChange;
  /** Takes the state (the verbs approve and reject count too): the word, the actions, an announcement, ds:change. */
  set(value: PlanStateName | 'approve' | 'reject'): void;
  on(type: 'change', fn: (detail: PlanChange) => void): () => void;
  /** Reads data-ds-plan-state again (the observer calls it). */
  update(): void;
  destroy(): void;
}

/** The states of a plan, in their order. */
export declare const PLAN_STATES: readonly PlanStateName[];
/** A state as the card takes it: one of PLAN_STATES, 'waiting' for anything else. */
export declare function planState(value: string | null | undefined): PlanStateName;
/** A plan card driven from the page. */
export declare function create(el: Element, options?: { state?: PlanStateName }): PlanController;
