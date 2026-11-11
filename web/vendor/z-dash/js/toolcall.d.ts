/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.toolcall (src/components/toolcall/toolcall.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export type ToolcallStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ToolcallOptions {
  /** Default: the row's data-status, else pending. */
  status?: ToolcallStatus;
  /** When it started: a Date, a timestamp in ms or a date text. */
  since?: Date | number | string;
  /** The duration in ms, once known. */
  duration?: number | null;
}

export interface ToolcallState {
  status: ToolcallStatus;
  /** The ms shown, or null. */
  duration: number | null;
}

export interface ToolcallChanges {
  status?: ToolcallStatus;
  /** The status word, written to .ds-toolcall__word. */
  label?: string;
  duration?: number | null;
  since?: Date | number | string;
}

export interface ToolcallController {
  get(): ToolcallState;
  set(changes?: ToolcallChanges): void;
  on(type: 'change', fn: (detail: ToolcallState) => void): () => void;
  /** Reads the changed attributes again (the attribute path calls it). */
  update(names?: string[]): void;
  destroy(): void;
}

/** The statuses: pending, running, done, failed, cancelled. */
export declare const STATUSES: readonly ToolcallStatus[];
/** A duration as a tool call shows it: "240ms", "12s", "1m 5s". */
export declare function durationText(ms: number | null | undefined): string;
/** A tool call driven from the page. */
export declare function create(el: Element, options?: ToolcallOptions): ToolcallController;
