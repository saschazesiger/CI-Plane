/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <UsageMeter> (react/usage.js), generated from src/components/usage/. */
import type { BehaviourComponent } from './shared.js';

export type UsageMeterVariant = 'inline';

export interface UsageMeterEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface UsageMeterOptions {
  /** data-ds-usage-used (true: present, false or none: absent). */
  used?: string | number | boolean | object | null;
  /** data-ds-usage-budget (true: present, false or none: absent). */
  budget?: string | number | boolean | object | null;
  /** data-ds-usage-cost (true: present, false or none: absent). */
  cost?: string | number | boolean | object | null;
  /** data-ds-usage-cost-budget (true: present, false or none: absent). */
  costBudget?: string | number | boolean | object | null;
  /** data-ds-usage-currency (true: present, false or none: absent). */
  currency?: string | number | boolean | object | null;
  /** data-ds-usage-warn (true: present, false or none: absent). */
  warn?: string | number | boolean | object | null;
}

export declare const UsageMeter: BehaviourComponent<'section', UsageMeterVariant, UsageMeterEvents & UsageMeterOptions, ReturnType<typeof import('../js/usage.js').create>>;
