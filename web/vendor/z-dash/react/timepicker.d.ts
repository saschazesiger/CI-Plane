/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <TimePicker> (react/timepicker.js), generated from src/components/timepicker/. */
import type { BehaviourComponent } from './shared.js';

export type TimePickerVariant = 'block';

export interface TimePickerEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TimePickerOptions {
}

export declare const TimePicker: BehaviourComponent<'div', TimePickerVariant, TimePickerEvents & TimePickerOptions, ReturnType<typeof import('../js/timepicker.js').create>>;
