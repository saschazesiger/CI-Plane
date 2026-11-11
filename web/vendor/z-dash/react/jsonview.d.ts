/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <JsonView> (react/jsonview.js), generated from src/components/jsonview/. */
import type { BehaviourComponent } from './shared.js';

export type JsonViewVariant = never;

export interface JsonViewEvents {
  /** ds:copy on the root. */
  onDsCopy?: (event: CustomEvent) => void;
  /** ds:error on the root. */
  onDsError?: (event: CustomEvent) => void;
  /** ds:search on the root. */
  onDsSearch?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
  /** ds:toggle on the root. */
  onDsToggle?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface JsonViewOptions {
  /** data-ds-jsonview-open (true: present, false or none: absent). */
  dsJsonviewOpen?: string | number | boolean | object | null;
  /** data-ds-jsonview-search (true: present, false or none: absent). */
  search?: string | number | boolean | object | null;
}

export declare const JsonView: BehaviourComponent<'div', JsonViewVariant, JsonViewEvents & JsonViewOptions, ReturnType<typeof import('../js/jsonview.js').create>>;
