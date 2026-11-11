/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.selectpanel (js/selectpanel.js). */
import type { ListboxController, ListboxItem } from './listbox.js';

export interface SelectpanelOptions {
  /** Data (as DS.listbox); default the markup's options. */
  items?: ListboxItem[];
  /** Several values (default aria-multiselectable on the list). */
  multiple?: boolean;
  /** The first value (default data-ds-value, else the options marked aria-selected). */
  value?: string | string[] | null;
  /** As DS.listbox: true, false, or the number of items from which the list is windowed. */
  virtual?: boolean | number;
  /** Hidden inputs of this name carry the applied value in a form. */
  name?: string;
}

export interface SelectpanelController {
  readonly element: Element;
  readonly list: ListboxController;
  get(): string | string[] | null;
  set(value: string | string[] | null): void;
  on(type: 'change', fn: (detail: { value: string | string[] | null }) => void): () => void;
  setItems(items: ListboxItem[]): void;
  open(): Promise<void>;
  close(commit?: boolean): Promise<void>;
  destroy(): void;
}

/** The button's summary of a choice: '', one or two names, "3 selected" or "All selected". */
export declare function summarize(names: string[], total: number): string;
/** The controller of a select panel, the one [data-ds-selectpanel] makes. */
export declare function create(element: Element, options?: SelectpanelOptions): SelectpanelController | null;
/** Opens a select panel through DS.overlay. */
export declare function open(element: Element): Promise<void>;
/** Closes a select panel; `commit: true` applies the pending choice first. */
export declare function close(element: Element, options?: { commit?: boolean }): Promise<void>;
