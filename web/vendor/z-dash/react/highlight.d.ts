/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Highlight> (react/highlight.js), generated from src/components/highlight/. */
import type { BehaviourComponent } from './shared.js';

export type HighlightVariant = never;

export interface HighlightEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes, and its content. */
export interface HighlightOptions {
  /** The text the behaviour renders; string children give it too. */
  code?: string;
  children?: string | number;
}

export declare const Highlight: BehaviourComponent<'code', HighlightVariant, HighlightEvents & HighlightOptions, ReturnType<typeof import('../js/highlight.js').create>>;
