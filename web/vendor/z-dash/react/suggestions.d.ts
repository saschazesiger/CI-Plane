/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Suggestions> (react/suggestions.js), generated from src/components/suggestions/. */
import type { BehaviourComponent } from './shared.js';

export type SuggestionsVariant = 'wrap';

export interface SuggestionsEvents {
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SuggestionsOptions {
}

export declare const Suggestions: BehaviourComponent<'div', SuggestionsVariant, SuggestionsEvents & SuggestionsOptions, ReturnType<typeof import('../js/suggestions.js').create>>;
