/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.loadmore (js/loadmore.js). */

export type LoadMoreState = 'idle' | 'loading' | 'error' | 'done';

export interface LoadMoreSnapshot {
  loaded: number | null;
  total: number | null;
  state: LoadMoreState;
}

/** What a load returns: the counts, done, or the number of items it added. */
export type LoadMoreResult = number | { loaded?: number; total?: number | null; added?: number; done?: boolean } | void;

export interface LoadMoreOptions {
  loaded?: number | null;
  total?: number | null;
  /** An infinite scroll: at most this many automatic loads (Infinity: no limit; 0: none). */
  auto?: number;
  /** A selector of the list. */
  for?: string | null;
  /** 'new': after a load from the button, focus moves to the first new item. */
  focus?: 'new' | null;
  /** A selector of the scroller the sentinel watches. */
  root?: string | null;
  /** The observer's rootMargin. */
  margin?: string | null;
  load?: (state: { loaded: number | null; total: number | null; auto: boolean }) => LoadMoreResult | PromiseLike<LoadMoreResult>;
  status?: (state: LoadMoreSnapshot) => string;
}

export interface LoadMoreController {
  get(): LoadMoreSnapshot;
  /** The answer to ds:loadmore, new counts, or { error } for a failure. */
  set(value?: { loaded?: number; total?: number | null; added?: number; done?: boolean; error?: unknown }): void;
  /** A load now, as the button. */
  load(): Promise<LoadMoreSnapshot>;
  /** A new query: back to the start; a load still running is dropped. */
  reset(value?: { loaded?: number; total?: number | null }): void;
  on(type: 'change', fn: (detail: LoadMoreSnapshot & { added?: number; error?: unknown }) => void): () => void;
  update(): void;
  destroy(): void;
}

/** The default status text of a state. */
export declare function statusText(state: LoadMoreSnapshot): string;
/** The controller data-ds-loadmore makes (an element that has one returns it, and gets load and status). */
export declare function create(el: Element, options?: LoadMoreOptions): LoadMoreController;
