/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Listbox> (react/listbox.js), generated from src/components/listbox/. */
import type { BehaviourComponent } from './shared.js';

export type ListboxVariant = 'plain';

export interface ListboxEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ListboxOptions {
}

export declare const Listbox: BehaviourComponent<'div', ListboxVariant, ListboxEvents & ListboxOptions, ReturnType<typeof import('../js/listbox.js').create>>;
