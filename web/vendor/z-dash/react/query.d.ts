/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <QueryInput> (react/query.js), generated from src/components/query/. */
import type { BehaviourComponent } from './shared.js';

export type QueryInputVariant = never;

export interface QueryInputEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:saved on the root. */
  onDsSaved?: (event: CustomEvent) => void;
  /** ds:submit on the root. */
  onDsSubmit?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface QueryInputOptions {
}

export declare const QueryInput: BehaviourComponent<'div', QueryInputVariant, QueryInputEvents & QueryInputOptions, ReturnType<typeof import('../js/query.js').create>>;
