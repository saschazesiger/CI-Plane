/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <DatePicker> (react/datepicker.js), generated from src/components/datepicker/. */
import type { BehaviourComponent } from './shared.js';

export type DatePickerVariant = 'block';

export interface DatePickerEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DatePickerOptions {
}

export declare const DatePicker: BehaviourComponent<'div', DatePickerVariant, DatePickerEvents & DatePickerOptions, ReturnType<typeof import('../js/datepicker.js').create>>;
