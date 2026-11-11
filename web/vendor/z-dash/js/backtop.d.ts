/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.backtop (src/components/backtop/backtop.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface BacktopOptions {
  /** px of scroll after which the button shows (default: one height of the scroller); it hides under half of it. */
  after?: number | null;
  /** The scroller (an element or a selector; the page for <html> or <body>); default the nearest scrolling ancestor, else the page. */
  target?: Element | string | null;
  /** What takes the focus at the top (an element or a selector); default a box's first heading (the page's first h1), else the scroller. */
  focus?: Element | string | null;
}

export interface BacktopController {
  /** Whether the button shows. */
  get(): boolean;
  /** Shows or hides the button until the next scroll decides again. */
  set(value: boolean): void;
  on(type: 'change', fn: (detail: { shown: boolean }) => void): () => void;
  /** Scrolls the scroller to its top and moves the focus there, as a click does. */
  go(): void;
  destroy(): void;
}

/** Whether the button shows at a scroll position: past `after` it shows, under half of it it hides, in between it keeps `shown`. */
export declare function shown(top: number, options: { after: number; shown?: boolean }): boolean;
/** A back-to-top button driven from the page. */
export declare function create(el: HTMLElement, options?: BacktopOptions): BacktopController;
