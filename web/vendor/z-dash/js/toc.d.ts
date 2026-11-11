/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.toc (src/components/toc/toc.js). Hand-written; the build test
 * keeps the declared exports and their parameters equal to the module's.
 */

export interface TocOptions {
  /** The reading line, px below the top of the scroller (default: the sections' scroll-margin-top plus a quarter of its height). */
  offset?: number | null;
  /** Write the section's hash with history.pushState on a jump (default true). */
  hash?: boolean;
}

export interface TocChange {
  id: string;
  link: HTMLElement;
  target: HTMLElement;
  /** 'scroll' (the reader scrolled) or 'link' (a link or set() jumped). */
  reason: 'scroll' | 'link';
}

export interface TocController {
  /** The id of the current section, or null. */
  get(): string | null;
  /** Goes to a section (its id, link or element): scrolls, focuses and marks it; whether it was found. */
  set(value: string | Element): boolean;
  on(type: 'change', fn: (detail: TocChange) => void): () => void;
  /** Reads the links, the sections and their places again. */
  refresh(): void;
  destroy(): void;
}

/** Which section is current, from the tops of the sections (px from the top of the view). */
export declare function current(tops: number[], options: { line: number; bottom: number; atEnd?: boolean; pinned?: number }): number;
/** A table of contents driven from the page. */
export declare function create(el: HTMLElement, options?: TocOptions): TocController;
