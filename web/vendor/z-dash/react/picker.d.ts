/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Picker> (react/picker.js), generated from src/components/picker/. */
import type { BehaviourComponent } from './shared.js';

export type PickerVariant = 'block';

export interface PickerEvents {
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:open on the root. */
  onDsOpen?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface PickerOptions {
}

export declare const Picker: BehaviourComponent<'div', PickerVariant, PickerEvents & PickerOptions, ReturnType<typeof import('../js/picker.js').create>>;
