/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <ToggleGroup> (react/toggle-group.js), generated from src/components/toggle/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type ToggleGroupVariant = never;

export interface ToggleGroupEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ToggleGroupOptions {
  /** data-ds-toggle-group-required (true: present, false or none: absent). */
  dsToggleGroupRequired?: string | number | boolean | object | null;
  /** data-ds-value (true: present, false or none: absent). */
  dsValue?: string | number | boolean | object | null;
  /** data-ds-toggle-group-roving (true: present, false or none: absent). */
  roving?: string | number | boolean | object | null;
}

export declare const ToggleGroup: BehaviourComponent<'div', ToggleGroupVariant, ToggleGroupEvents & ToggleGroupOptions, Controller>;
