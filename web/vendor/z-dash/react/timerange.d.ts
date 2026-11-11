/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <TimeRange> (react/timerange.js), generated from src/components/timerange/. */
import type { BehaviourComponent } from './shared.js';

export type TimeRangeVariant = never;

export interface TimeRangeEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:refresh on the root. */
  onDsRefresh?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TimeRangeOptions {
}

export declare const TimeRange: BehaviourComponent<'div', TimeRangeVariant, TimeRangeEvents & TimeRangeOptions, ReturnType<typeof import('../js/timerange.js').create>>;
