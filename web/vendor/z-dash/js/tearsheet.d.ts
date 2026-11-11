/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.tearsheet (js/tearsheet.js). */
import type { OpenOptions } from './overlay.js';

/** Where a tearsheet is. */
export interface TearsheetState {
  /** The current step, from 0. */
  step: number;
  /** How many steps it has. */
  total: number;
  /** Whether it has unsaved changes. */
  dirty: boolean;
  /** Whether it is open. */
  open: boolean;
}

/** The texts of the question before unsaved changes go. */
export interface DiscardTexts {
  title?: string;
  text?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** The controller of a tearsheet. */
export interface TearsheetController {
  element: Element;
  get(): TearsheetState;
  /** A step (without checking it), or { step, dirty }. */
  set(value: number | { step?: number; dirty?: boolean }): void;
  /** The next step, after checking the current one; resolves whether it moved. */
  next(): Promise<boolean>;
  /** The step before; resolves whether it moved. */
  back(): Promise<boolean>;
  /** Closes it, asking first while it has unsaved changes; resolves whether it closed. */
  close(options?: { force?: boolean; reason?: string }): Promise<boolean>;
  /** Hears ds:step, ds:change, ds:submit, ds:dirty, ds:open and ds:close; returns the unsubscribe. */
  on(type: string, fn: (event: Event) => void): () => void;
  destroy(): void;
}

/** The detail of ds:submit: wait(promise) keeps it open and busy until the promise settles. */
export interface TearsheetSubmitDetail {
  form: HTMLFormElement | null;
  data: FormData | null;
  wait(promise: PromiseLike<unknown>): void;
}

/** The step index a request leads to: `to` within 0 and `total - 1`. */
export declare function stepIndex(to: number, total: number): number;
/** The rail's status of each step. */
export declare function statuses(total: number, current: number, errors?: Set<number> | number[]): Array<'done' | 'current' | 'upcoming' | 'error'>;
/** The controller of a tearsheet, the one [data-ds-tearsheet] makes. */
export declare function create(element: Element, options?: { discard?: DiscardTexts; errorText?: string }): TearsheetController;
/** Opens a tearsheet at its first step (or `step`): DS.overlay.open(). */
export declare function open(element: Element, options?: OpenOptions & { step?: number }): Promise<void>;
/** Closes a tearsheet; asks first while it has unsaved changes, unless `force`. Resolves whether it closed. */
export declare function close(element: Element, options?: { force?: boolean; reason?: string }): Promise<boolean>;
