/**
 * Types of DS.overlay (js/overlay.js). Hand-written; test/build.test.js
 * keeps the declared exports and their parameters equal to the module's,
 * and declares every `options.<name>` the module reads.
 */
import type { Destroyable } from './motion.js';

/** How long a snackbar stays (ms) before its length adds time. */
export declare const TOAST_MS: number;
/** The longest a snackbar stays on its own (ms). */
export declare const TOAST_MAX_MS: number;
/** At most this many snackbars show at once. */
export declare const TOAST_LIMIT: number;
/** --ds-delay-tooltip outside a theme (ms). */
export declare const TOOLTIP_DELAY_MS: number;
/** --ds-delay-tooltip-skip outside a theme (ms). */
export declare const TOOLTIP_SKIP_MS: number;
/** --ds-delay-tooltip-hide outside a theme (ms). */
export declare const TOOLTIP_HIDE_MS: number;
/** --ds-delay-dismiss outside a theme (ms). */
export declare const DISMISS_DELAY_MS: number;
/** The media query under which the modal drawer exists. */
export declare const DRAWER_QUERY: string;

/** Reference-counted scroll lock of the page. */
export declare function lockScroll(doc?: Document): void;
export declare function unlockScroll(doc?: Document): void;

export interface OpenOptions {
  /** Gets focus back on close (default: the focused element, else the control the current event came from). */
  opener?: Element | null;
  /** Grows the opener into a dialog or sheet. */
  container?: boolean;
  /** Where focus goes on close when the opener is gone (2.0). */
  returnTo?: () => Element | null | undefined;
}
/** Opens a dialog, side sheet, the modal drawer, a menu or the combobox list. */
export declare function open(element: Element, options?: OpenOptions): Promise<void>;

/** What the ds-close event says; any other string is the page's own. */
export type CloseReason = 'escape' | 'backdrop' | 'close' | 'item' | 'tab' | 'outside' | 'parent' | 'api' | 'removed' | 'breakpoint' | (string & {});
/** Closes an overlay that open() showed; `reason` (default 'api') also closes a busy one. */
export declare function close(element: Element, options?: { reason?: CloseReason }): Promise<void>;
/** The topmost open layer of the page, or null. */
export declare function topmost(doc?: Document): Element | null;

export interface ConfirmOptions {
  title?: string;
  text?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  opener?: Element | null;
  onConfirm?: () => unknown;
  errorText?: string;
}
/** A built confirm dialog; resolves true on confirm. */
export declare function confirm(options?: ConfirmOptions): Promise<boolean>;
/** A built alert dialog. */
export declare function alert(options?: { title?: string; text?: string; closeLabel?: string; opener?: Element | null }): Promise<void>;
export interface PromptOptions {
  title?: string;
  text?: string;
  label?: string;
  value?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  opener?: Element | null;
  onConfirm?: (value: string) => unknown;
  errorText?: string;
  /** The field error of a required field left empty (default "Enter a value."). */
  requiredText?: string;
  input?: {
    type?: string;
    autocomplete?: string;
    inputmode?: string;
    required?: boolean;
    /** Sets the attribute "true" or "false"; absent, the browser's default. */
    spellcheck?: boolean;
    /** The attributes of the same name (e.g. "off", "none", "done"); absent, not written. */
    autocapitalize?: string;
    autocorrect?: string;
    enterkeyhint?: string;
  };
}
/** A built prompt dialog; resolves with the value, or null when cancelled. */
export declare function prompt(options?: PromptOptions): Promise<string | null>;

/** The page's snackbar region (.ds-toasts), created when missing; null without a DOM. */
export declare function toastRegion(doc?: Document): HTMLElement | null;
/** Says `text` to assistive technology without a snackbar. */
export declare function announce(text: string, options?: { assertive?: boolean; region?: Element | null }): void;

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastHandle {
  el: HTMLElement | null;
  /** Takes it away (a waiting one leaves the queue). */
  close(): Promise<void>;
  /** Resolves once it is gone. */
  closed: Promise<void>;
}
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
/** Shows a snackbar in `region` (null: the page's region). */
export declare function toast(region: Element | null, content: Element | string, options?: ToastOptions): ToastHandle;
/** Closes the snackbars of `region` that match `filter`. */
export declare function closeToasts(region?: Element | null, filter?: { kind?: ToastKind; key?: string }): Promise<void>;
/** Tooltips for every [data-tip] trigger under `root`. */
export declare function tooltips(root?: Document | Element | ShadowRoot): Destroyable;

export interface SavebarHandle extends Destroyable {
  element: Element;
  show(): void;
  hide(): void;
  update(fn: () => void): void;
  readonly shown: boolean;
}
/** The save bar of a form with unsaved changes. */
export declare function savebar(element: Element, options?: { focusTarget?: () => Element | null | undefined }): SavebarHandle;
