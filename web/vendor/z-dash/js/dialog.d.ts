/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.dialog (js/dialog.js). */
import type { CloseReason, OpenOptions, OverlayController } from './overlay.js';

/** What a built dialog's question is about, under its text. */
export interface AboutOptions {
  /** A list of the items it concerns (.ds-dialog__lines). */
  lines?: string[];
  /** Term and value pairs (.ds-dialog__facts). */
  facts?: Array<[string, string]>;
}
export interface ConfirmOptions extends AboutOptions {
  title?: string;
  text?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  opener?: Element | null;
  onConfirm?: () => unknown;
  errorText?: string;
}
export interface PromptOptions extends AboutOptions {
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

/** Opens a dialog: DS.overlay.open(). */
export declare function open(element: Element, options?: OpenOptions): Promise<void>;
/** Closes a dialog: DS.overlay.close(). */
export declare function close(element: Element, options?: { reason?: CloseReason }): Promise<void>;
/** A built confirm dialog; `destructive` fills its button in the error tone. Resolves true on confirm. */
export declare function confirm(options?: ConfirmOptions): Promise<boolean>;
/** A built alert dialog. */
export declare function alert(options?: AboutOptions & { title?: string; text?: string; closeLabel?: string; opener?: Element | null }): Promise<void>;
/** A built prompt dialog; resolves with the value, or null when cancelled. */
export declare function prompt(options?: PromptOptions): Promise<string | null>;
/** Makes the dialog's box form run `onSubmit` before it closes. */
export declare function form(element: Element, options?: { onSubmit?: (data: FormData, form: HTMLFormElement) => unknown; errorText?: string }): OverlayController;
/** The controller of a dialog, the one [data-ds-dialog] makes. */
export declare function create(element: Element): OverlayController;
