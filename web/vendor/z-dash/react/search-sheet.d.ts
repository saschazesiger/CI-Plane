/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SearchSheet> (react/search-sheet.js), generated from src/components/shell/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type SearchSheetVariant = never;

export interface SearchSheetEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SearchSheetOptions {
}

export declare const SearchSheet: BehaviourComponent<'div', SearchSheetVariant, SearchSheetEvents & SearchSheetOptions, Controller>;
