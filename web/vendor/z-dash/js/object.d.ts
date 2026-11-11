/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.object (src/components/object/object.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface ObjectSave {
  section: HTMLElement;
  id: string | null;
  form: HTMLFormElement;
  /** The form's entries: a name once is its value, a name more than once a list. */
  values: Record<string, FormDataEntryValue | FormDataEntryValue[]>;
}

export interface ObjectCancel {
  section: HTMLElement;
  id: string | null;
  form: HTMLFormElement | null;
}

export interface ObjectController {
  /** The ids of the sections that edit. */
  get(): Array<string | null>;
  /** Edits exactly these sections (ids or elements; true: all, false or []: none); the others cancel. */
  set(value: boolean | string | Element | Array<string | Element> | null): void;
  on(type: 'change', fn: (detail: { editing: Array<string | null> }) => void): () => void;
  on(type: 'edit', fn: (detail: { section: HTMLElement; id: string | null }) => void): () => void;
  on(type: 'save', fn: (detail: ObjectSave) => void): () => void;
  on(type: 'cancel', fn: (detail: ObjectCancel) => void): () => void;
  /** Turns a section (an element or its id), or every section (null), into its form; whether one changed. */
  edit(target?: string | Element | null): boolean;
  /** Submits a section's form (or every one that edits, null), validating first; whether there was one. */
  save(target?: string | Element | null): boolean;
  /** Cancels a section (or every one that edits, null): the form resets, the view comes back; whether one changed. */
  cancel(target?: string | Element | null): boolean;
  /** Leaves a section's form after the page saved it; whether it did. */
  done(target: string | Element): boolean;
  destroy(): void;
}

/** The values of a form's entries as a plain object (a repeated name: a list). */
export declare function values(entries: Iterable<[string, FormDataEntryValue]>): Record<string, FormDataEntryValue | FormDataEntryValue[]>;
/** An object page driven from the page. */
export declare function create(el: HTMLElement): ObjectController;
