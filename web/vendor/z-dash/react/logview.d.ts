/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <LogView> (react/logview.js), generated from src/components/logview/. */
import type { BehaviourComponent } from './shared.js';

export type LogViewVariant = never;

export interface LogViewEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:copy on the root. */
  onDsCopy?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LogViewOptions {
  /** data-ds-logview-wrap (true: present, false or none: absent). */
  dsLogviewWrap?: string | number | boolean | object | null;
  /** data-ds-logview-time (true: present, false or none: absent). */
  time?: string | number | boolean | object | null;
  /** data-ds-logview-limit (true: present, false or none: absent). */
  limit?: string | number | boolean | object | null;
  /** data-ds-logview-follow (true: present, false or none: absent). */
  follow?: string | number | boolean | object | null;
  /** data-ds-logview-tools (true: present, false or none: absent). */
  tools?: string | number | boolean | object | null;
}

export declare const LogView: BehaviourComponent<'div', LogViewVariant, LogViewEvents & LogViewOptions, ReturnType<typeof import('../js/logview.js').create>>;
