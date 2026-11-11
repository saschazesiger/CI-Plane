/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <LoadMore> (react/loadmore.js), generated from src/components/loadmore/. */
import type { BehaviourComponent } from './shared.js';

export type LoadMoreVariant = 'inline';

export interface LoadMoreEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:loaded on the root. */
  onDsLoaded?: (event: CustomEvent) => void;
  /** ds:loadmore on the root. */
  onDsLoadmore?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LoadMoreOptions {
  /** data-ds-loadmore-loaded (true: present, false or none: absent). */
  loaded?: string | number | boolean | object | null;
  /** data-ds-loadmore-total (true: present, false or none: absent). */
  total?: string | number | boolean | object | null;
  /** data-ds-loadmore-auto (true: present, false or none: absent). */
  auto?: string | number | boolean | object | null;
  /** data-ds-loadmore-for (true: present, false or none: absent). */
  dsLoadmoreFor?: string | number | boolean | object | null;
  /** data-ds-loadmore-focus (true: present, false or none: absent). */
  focus?: string | number | boolean | object | null;
  /** data-ds-loadmore-root (true: present, false or none: absent). */
  root?: string | number | boolean | object | null;
  /** data-ds-loadmore-margin (true: present, false or none: absent). */
  margin?: string | number | boolean | object | null;
}

export declare const LoadMore: BehaviourComponent<'div', LoadMoreVariant, LoadMoreEvents & LoadMoreOptions, ReturnType<typeof import('../js/loadmore.js').create>>;
