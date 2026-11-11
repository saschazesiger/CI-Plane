/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.unsaved (src/components/unsaved/unsaved.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface UnsavedState {
  dirty: boolean;
  /** How many fields differ from the baseline (a radio group counts once). */
  count: number;
  /** The groups that differ: a radio group's name, else `<name>[<n>]`. */
  changed: string[];
}

export interface UnsavedSaveEvent {
  changed: string[];
  /** Hands the guard the save: busy face, then the new baseline on success. */
  waitUntil(promise: PromiseLike<unknown>): void;
}

export interface UnsavedOptions {
  /** The .ds-savebar to drive (null: none); default data-ds-unsaved-savebar, one in the form, the one of its .ds-view. */
  savebar?: Element | null;
  /** The save shortcut (default 'mod+s'; 'off': none). */
  hotkey?: string;
  /** false: leave the fields' .ds-field--changed alone. */
  marks?: boolean;
  /** Saves when no ds:save listener called waitUntil(). */
  onSave?: (changed: string[]) => unknown;
}

export interface UnsavedController {
  get(): UnsavedState;
  /** false: what the fields hold now is saved (commit); true: unsaved whatever the fields say. */
  set(value: boolean): void;
  /** Compares the fields again (after the page changed one from a script). */
  check(): void;
  /** What the fields hold now becomes the baseline. */
  commit(): void;
  /** Every field back to the baseline. */
  discard(): void;
  /** Sends ds:save; resolves whether it saved. */
  save(): Promise<boolean>;
  on(type: 'change', fn: (detail: UnsavedState) => void): () => void;
  on(type: 'save', fn: (detail: UnsavedSaveEvent) => void): () => void;
  on(type: 'saved' | 'discard', fn: (detail: { changed: string[] }) => void): () => void;
  on(type: 'error', fn: (detail: { error: unknown }) => void): () => void;
  destroy(): void;
}

export interface UnsavedEntry {
  group: string;
  value: string;
  field: Element;
}

/** The state of a form's fields, one entry per control. */
export declare function snapshot(form: { elements: ArrayLike<Element> }): Map<string, UnsavedEntry>;
/** The groups whose value differs between two snapshots. */
export declare function diff(before: Map<string, { group: string; value: string }>, after: Map<string, { group: string; value: string }>): string[];
/** Whether a guard in `root` (default: the page) holds unsaved changes. */
export declare function isDirty(root?: Document | Element): boolean;
/** Runs `go()` once nothing is unsaved or the person agreed to discard; resolves whether it went. */
export declare function navigate(go: () => unknown, options?: {
  root?: Document | Element;
  opener?: Element | null;
  title?: string;
  text?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean>;
/** A guard driven from the page. */
export declare function create(form: HTMLFormElement, options?: UnsavedOptions): UnsavedController;
