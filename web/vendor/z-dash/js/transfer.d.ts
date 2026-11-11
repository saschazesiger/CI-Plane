/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.transfer (js/transfer.js). */
import type { ListboxController, ListboxItem } from './listbox.js';

export interface TransferOptions {
  /** Every option (as DS.listbox); default the markup's of both lists. */
  items?: ListboxItem[];
  /** The target's values (default the target list's markup). */
  value?: string[];
  /** As DS.listbox: true, false, or the number of items from which a side is windowed. */
  virtual?: boolean | number;
}

export interface TransferController {
  readonly element: Element;
  readonly lists: { source: ListboxController, target: ListboxController };
  get(): string[];
  set(value: string[]): void;
  on(type: 'change', fn: (detail: { value: string[] }) => void): () => void;
  move(values: string | string[], toTarget?: boolean): boolean;
  destroy(): void;
}

/** The two sides after a move: `moving` goes from `from` to the end of `to`, or into `to` in the order of `all`. */
export declare function move(from: string[], to: string[], moving: string[], all?: string[] | null): { from: string[], to: string[] };
/** The controller of a transfer list, the one [data-ds-transfer] makes. */
export declare function create(element: Element, options?: TransferOptions): TransferController | null;
