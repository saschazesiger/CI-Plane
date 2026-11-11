/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <SavedViews> (react/views.js), generated from src/components/views/. */
import type { BehaviourComponent } from './shared.js';

export type SavedViewsVariant = never;

export interface SavedViewsEvents {
  /** ds:view on the root. */
  onDsView?: (event: CustomEvent) => void;
  /** ds:views on the root. */
  onDsViews?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SavedViewsOptions {
  /** data-ds-views-key (true: present, false or none: absent). */
  dsViewsKey?: string | number | boolean | object | null;
  /** data-ds-views-url (true: present, false or none: absent). */
  url?: string | number | boolean | object | null;
  /** data-ds-views-prefix (true: present, false or none: absent). */
  prefix?: string | number | boolean | object | null;
}

export declare const SavedViews: BehaviourComponent<'div', SavedViewsVariant, SavedViewsEvents & SavedViewsOptions, ReturnType<typeof import('../js/views.js').create>>;
