/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.toast (js/toast.js); DS.overlay.toast and the others call these. */
import type { ToastHandle, ToastKind } from './overlay.js';

export interface ToastOptions {
  kind?: ToastKind;
  persistent?: boolean;
  timeout?: number;
  closeLabel?: string;
  action?: { label: string; onClick?: (event: Event, handle: ToastHandle) => void };
  key?: string;
  restart?: boolean;
  reserve?: boolean;
}

/** The page's snackbar region (.ds-toasts), created when missing; null without a DOM. */
export declare function toastRegion(doc?: Document): HTMLElement | null;
/** Says `text` to assistive technology without a snackbar. */
export declare function announce(text: string, options?: { assertive?: boolean; region?: Element | null; key?: string }): void;
/** Shows a snackbar in `region` (null: the page's region). */
export declare function toast(region: Element | null, content: Element | string, options?: ToastOptions): ToastHandle;
/** Closes the snackbars of `region` that match `filter`. */
export declare function closeToasts(region?: Element | null, filter?: { kind?: ToastKind; key?: string }): Promise<void>;

/** What promise() shows: the waiting text, then the outcome's (a function of the value or the reason; empty closes it). */
export interface ToastPromiseOptions extends Omit<ToastOptions, 'kind' | 'action' | 'restart'> {
  pending?: string;
  success?: string | ((value: unknown) => string | null | false) | null | false;
  error?: string | ((reason: unknown) => string | null | false) | null | false;
}

/** The handle of a progress message: set() moves the bar, done() and fail() end it in place. */
export interface ToastProgressHandle extends ToastHandle {
  set(value: number | null, text?: string): void;
  done(text?: string, options?: { timeout?: number; persistent?: boolean }): void;
  fail(text?: string): void;
}

/** A message while `work` runs (a spinner), then its outcome in place. */
export declare function promise(region: Element | null, work: Promise<unknown> | (() => unknown), options?: ToastPromiseOptions): ToastHandle;
/** A message with a progress bar (`value` 0 to 1, null: not known yet). */
export declare function progress(region: Element | null, text: string, options?: Omit<ToastOptions, 'kind' | 'action' | 'restart'> & { value?: number | null }): ToastProgressHandle;
