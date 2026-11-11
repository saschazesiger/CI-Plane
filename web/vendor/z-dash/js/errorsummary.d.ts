/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.errorsummary (src/components/errorsummary/errorsummary.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface ErrorSummaryItem {
  /** The id of the field (the system gives one to a field without). */
  id: string;
  text: string;
}

export interface ErrorSummaryController {
  get(): { errors: ErrorSummaryItem[] };
  /** Shows the page's own problems (a server's answer); false when there is one. */
  set(problems: { field: Element | string; text: string }[]): boolean;
  /** Checks the form as a submit would; true when it has no problem. */
  validate(options?: { focus?: boolean }): boolean;
  /** Hides the summary and takes back what the system marked. */
  clear(): void;
  on(type: 'invalid' | 'change', fn: (detail: { errors: ErrorSummaryItem[] }) => void): () => void;
  destroy(): void;
}

/** The title of a summary of `count` problems; '' for none. */
export declare function title(count: number): string;
/** An error summary driven from the page. */
export declare function create(el: Element): ErrorSummaryController;
