/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SelectPanel> (react/selectpanel.js), generated from src/components/selectpanel/. */
import type { BehaviourComponent } from './shared.js';

export type SelectPanelVariant = never;

export interface SelectPanelEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SelectPanelOptions {
}

export declare const SelectPanel: BehaviourComponent<'div', SelectPanelVariant, SelectPanelEvents & SelectPanelOptions, ReturnType<typeof import('../js/selectpanel.js').create>>;
