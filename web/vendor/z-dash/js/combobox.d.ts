/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.combobox (js/combobox.js). */
import type { ListboxController, ListboxItem } from './listbox.js';

export interface ComboboxOptions {
  /** Data (as DS.listbox), rendered best first; default the markup's options, filtered in place. */
  items?: ListboxItem[];
  /** Asked as the field changes: a Promise of items. A newer query aborts the older one. */
  source?: (query: string, context: { signal: AbortSignal }) => Promise<ListboxItem[]> | ListboxItem[];
  /** The wait after the last key before a source is asked, in ms (default --ds-delay-loader). */
  debounce?: number;
  /** Letters before a source is asked (default 1; 0 asks for the empty field too, at once when the list opens). */
  minLength?: number;
  /** A last option creates the typed text (default data-ds-combobox-creatable). */
  creatable?: boolean;
  /** Several values (default .ds-combo--multi). */
  multiple?: boolean;
  /** The first value (default data-ds-value, else the options marked aria-selected). */
  value?: string | string[] | null;
  /** As DS.listbox: true, false, or the number of items (or results) from which the list is windowed; the markup's options never are. */
  virtual?: boolean | number;
  /** Hidden inputs of this name carry the value in a form. */
  name?: string;
}

export interface ComboboxController {
  readonly element: Element;
  readonly list: ListboxController;
  get(): string | string[] | null;
  set(value: string | string[] | null): void;
  on(type: 'change', fn: (detail: { value: string | string[] | null, item: ListboxItem | null }) => void): () => void;
  on(type: 'create', fn: (detail: { text: string }) => void): () => void;
  on(type: 'search', fn: (detail: { query: string }) => void): () => void;
  setItems(items: ListboxItem[]): void;
  open(): void;
  close(): void;
  destroy(): void;
}

/** The controller of a combobox, the one [data-ds-combobox] makes. */
export declare function create(element: Element, options?: ComboboxOptions): ComboboxController | null;
/** Opens a combobox's list: DS.overlay.open() on its popup. */
export declare function open(element: Element): Promise<void>;
/** Closes a combobox's list: DS.overlay.close() on its popup. */
export declare function close(element: Element): Promise<void>;
