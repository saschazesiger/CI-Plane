/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <List> (react/list.js), generated from src/components/list/. */
import type { BehaviourComponent } from './shared.js';

export type ListVariant = 'interactive' | 'scroll' | 'stacked';

export interface ListEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:copy on the root. */
  onDsCopy?: (event: CustomEvent) => void;
  /** ds:drop on the root. */
  onDsDrop?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ListOptions {
  /** data-ds-list-select (true: present, false or none: absent). */
  select?: string | number | boolean | object | null;
  /** data-ds-list-reorder (true: present, false or none: absent). */
  reorder?: string | number | boolean | object | null;
}

export declare const List: BehaviourComponent<'ul', ListVariant, ListEvents & ListOptions, ReturnType<typeof import('../js/list.js').create>>;
