/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SearchHits> (react/hits.js), generated from src/components/hits/. */
import type { BehaviourComponent } from './shared.js';

export type SearchHitsVariant = never;

export interface SearchHitsEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes, and its content. */
export interface SearchHitsOptions {
  /** data-ds-hits-mode (true: present, false or none: absent). */
  mode?: string | number | boolean | object | null;
  /** The text the behaviour renders; string children give it too. */
  text?: string;
  children?: string | number;
}

export declare const SearchHits: BehaviourComponent<'span', SearchHitsVariant, SearchHitsEvents & SearchHitsOptions, ReturnType<typeof import('../js/hits.js').create>>;
