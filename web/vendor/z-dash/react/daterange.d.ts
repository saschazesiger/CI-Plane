/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <DateRangePicker> (react/daterange.js), generated from src/components/daterange/. */
import type { BehaviourComponent } from './shared.js';

export type DateRangePickerVariant = 'block';

export interface DateRangePickerEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DateRangePickerOptions {
}

export declare const DateRangePicker: BehaviourComponent<'div', DateRangePickerVariant, DateRangePickerEvents & DateRangePickerOptions, ReturnType<typeof import('../js/daterange.js').create>>;
