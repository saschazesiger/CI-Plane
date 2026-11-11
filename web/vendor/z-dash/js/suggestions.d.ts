/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.suggestions (src/components/suggestions/suggestions.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface SuggestionItem {
  value?: string;
  label?: string;
  /** A glyph of DS.icons (DS.icons.sparkles). */
  icon?: string;
}

export interface SuggestionSelect {
  value: string;
  label: string;
  chip: Element;
}

export interface SuggestionsController {
  get(): { value: string; label: string }[];
  /** New chips, from texts or items. */
  set(next: Array<string | SuggestionItem>): void;
  on(type: 'select', fn: (detail: SuggestionSelect) => void): () => void;
  destroy(): void;
}

/** Items as the chips show them; empty ones go. */
export declare function items(list: Array<string | SuggestionItem>): { value: string; label: string; icon: string | null }[];
/** The controller of a row of suggestions: the one the attribute path makes. */
export declare function create(el: Element): SuggestionsController;
