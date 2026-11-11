/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SplitPane> (react/splitpane.js), generated from src/components/splitpane/. */
import type { BehaviourComponent } from './shared.js';

export type SplitPaneVariant = 'outlined' | 'stacked';

export interface SplitPaneEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SplitPaneOptions {
  /** data-ds-splitpane-store (true: present, false or none: absent). */
  store?: string | number | boolean | object | null;
  /** data-ds-splitpane-step (true: present, false or none: absent). */
  dsSplitpaneStep?: string | number | boolean | object | null;
  /** data-ds-splitpane-stack (true: present, false or none: absent). */
  stack?: string | number | boolean | object | null;
}

export declare const SplitPane: BehaviourComponent<'div', SplitPaneVariant, SplitPaneEvents & SplitPaneOptions, ReturnType<typeof import('../js/splitpane.js').create>>;
