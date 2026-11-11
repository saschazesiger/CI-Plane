/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.usage (src/components/usage/usage.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type UsageStateName = 'ok' | 'near' | 'over';

export interface UsageValues {
  /** Tokens used. */
  used?: number | null;
  /** The token budget. */
  budget?: number | null;
  /** What the tokens cost. */
  cost?: number | null;
  /** The money budget. */
  costBudget?: number | null;
}

export interface UsageOptions extends UsageValues {
  /** ISO 4217 (default 'USD'). */
  currency?: string;
  /** The share from which it is near the budget (default 0.8). */
  warn?: number;
}

export interface UsageState {
  used: number | null;
  budget: number | null;
  cost: number | null;
  costBudget: number | null;
  currency: string;
  /** The larger of the token and the cost share; null without a budget. */
  share: number | null;
  state: UsageStateName;
}

export interface UsageController {
  get(): UsageState;
  set(changes: UsageOptions): void;
  on(type: 'change', fn: (state: UsageState) => void): () => void;
  /** Reads the data-ds-usage-* attributes again (the observer calls it). */
  update(): void;
  destroy(): void;
}

/** The share of a budget used: the larger of the token and the cost share; null without a budget. */
export declare function shareOf(values?: UsageValues): number | null;
/** 'over' past 1, 'near' from warn (default 0.8), else 'ok'. */
export declare function stateOf(share: number | null, warn?: number): UsageStateName;
/** "182.4K tokens", or "182.4K of 250K tokens" against a budget. */
export declare function usageText(used: number | null, budget?: number | null): string;
/** "$3.12", or "$3.12 of $5.00" against a budget. */
export declare function costText(cost: number | null, costBudget?: number | null, code?: string): string;
/** A usage meter driven from the page. */
export declare function create(el: Element, options?: UsageOptions): UsageController;
