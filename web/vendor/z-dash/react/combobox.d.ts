/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Combobox> (react/combobox.js), generated from src/components/combobox/. */
import type { BehaviourComponent } from './shared.js';

export type ComboboxVariant = 'multi' | 'select';

export interface ComboboxEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:create on the root. */
  onDsCreate?: (event: CustomEvent) => void;
  /** ds:search on the root. */
  onDsSearch?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ComboboxOptions {
}

export declare const Combobox: BehaviourComponent<'div', ComboboxVariant, ComboboxEvents & ComboboxOptions, ReturnType<typeof import('../js/combobox.js').create>>;
