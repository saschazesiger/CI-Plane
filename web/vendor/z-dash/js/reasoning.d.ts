/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.reasoning (src/components/reasoning/reasoning.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface ReasoningOptions {
  /** When it started: a Date, a timestamp in ms or a date text (default: now). */
  since?: Date | number | string;
  /** Already ended (default false). */
  done?: boolean;
  /** With done: the total time in ms. */
  total?: number;
  /** Open while it runs, close at the end, unless the reader toggled it (default false). */
  auto?: boolean;
}

export interface ReasoningState {
  done: boolean;
  /** ms since it started; the total once it ended. */
  elapsed: number;
  open: boolean;
}

export interface ReasoningChanges {
  done?: boolean;
  total?: number;
  since?: Date | number | string;
  /** The page's own summary line ('' gives the line back to the module). */
  summary?: string;
}

export interface ReasoningController {
  get(): ReasoningState;
  set(changes?: ReasoningChanges): void;
  on(type: 'change', fn: (detail: ReasoningState) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The summary the module writes: "Thinking", or "Thought for 12s" once done. */
export declare function summaryText(ms: number, done: boolean): string;
/** A reasoning disclosure driven from the page. */
export declare function create(el: Element, options?: ReasoningOptions): ReasoningController;
