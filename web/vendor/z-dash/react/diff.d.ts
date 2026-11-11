/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Diff> (react/diff.js), generated from src/components/diff/. */
import type { BehaviourComponent } from './shared.js';

export type DiffVariant = 'wrap';

export interface DiffEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:expand on the root. */
  onDsExpand?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DiffOptions {
  /** data-ds-diff-view (true: present, false or none: absent). */
  view?: string | number | boolean | object | null;
  /** data-ds-diff-context (true: present, false or none: absent). */
  context?: string | number | boolean | object | null;
  /** data-ds-diff-lang (true: present, false or none: absent). */
  dsDiffLang?: string | number | boolean | object | null;
  /** data-ds-diff-heading (true: present, false or none: absent). */
  heading?: string | number | boolean | object | null;
}

export declare const Diff: BehaviourComponent<'div', DiffVariant, DiffEvents & DiffOptions, ReturnType<typeof import('../js/diff.js').create>>;
