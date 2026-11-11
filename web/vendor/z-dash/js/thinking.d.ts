/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.thinking (src/components/thinking/thinking.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export interface ThinkingOptions {
  /** The first step, shown at once (default ''). */
  step?: string;
  /** When it started: a Date, a timestamp in ms or a date text (default: now). */
  since?: Date | number | string;
  /** The tokens used so far (default: none shown). */
  tokens?: number | null;
  /** Already ended (default false). */
  done?: boolean;
}

export interface ThinkingState {
  step: string;
  thought: string;
  tokens: number | null;
  /** ms since it started; the total once it ended. */
  elapsed: number;
  done: boolean;
}

export interface ThinkingChanges {
  step?: string;
  thought?: string;
  tokens?: number | null;
  since?: Date | number | string;
  /** true ends it: the time stops and the shimmer goes. */
  done?: boolean;
  /** With done: the total time in ms (default: the time until now). */
  total?: number;
}

export interface ThinkingController {
  get(): ThinkingState;
  set(changes?: ThinkingChanges): void;
  on(type: 'change', fn: (detail: ThinkingState) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** A moment in ms from a Date, a timestamp or a date text; null when it is none. */
export declare function sinceOf(value: Date | number | string | null | undefined): number | null;
/** A length of time as it shows: "12s", "1m 5s". */
export declare function elapsedText(ms: number): string;
/** A length of time as an ISO 8601 duration: "PT1M5S". */
export declare function isoDuration(ms: number): string;
/** A token count as it shows: "1.2K tokens". */
export declare function tokensText(count: number | string | null | undefined): string;
/** A thinking indicator driven from the page. */
export declare function create(el: Element, options?: ThinkingOptions): ThinkingController;
