/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.list (src/components/list/list.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */
import type { VirtualController } from './virtual.js';

export interface ListVirtualOptions {
  /** How many rows. */
  count: number;
  /** The markup of one row: one li.ds-list__item with its data-ds-key. */
  render: (index: number) => string;
  /** The key of a row, so selection holds for rows that are not rendered. */
  key?: (index: number) => string | number;
  /** The element that scrolls (default the list: give it .ds-list--scroll). */
  scroller?: Element;
  /** Any other option of DS.virtual.create (estimate, overscan, ...). */
  [option: string]: unknown;
}

export interface ListOptions {
  /** 'multiple' (checkboxes) or 'single' (radios); null: no selection. */
  select?: 'multiple' | 'single' | null;
  /** Rows move by their grip (DS.dnd). */
  reorder?: boolean;
  /** A window over many rows (DS.virtual). */
  virtual?: ListVirtualOptions;
}

export interface ListController {
  /** Multiple: the checked keys; single: the checked key or null. */
  get(): string[] | string | null;
  set(value: string[] | string | null): void;
  on(type: 'change', fn: (detail: { keys: string[]; key: string | null; checked: boolean }) => void): () => void;
  on(type: string, fn: (detail: any) => void): () => void;
  /** The DS.virtual controller of a windowed list, else null. */
  window(): VirtualController | null;
  configure(options?: ListOptions): void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

export interface FactsController {
  /** The values: [label, text] in order. */
  get(): Array<[string, string]>;
  /** Writes the copy buttons again (values added by the page). */
  set(): void;
  on(type: 'copy', fn: (detail: { text: string; label: string }) => void): () => void;
  on(type: string, fn: (detail: any) => void): () => void;
  update(): void;
  destroy(): void;
}

/** The keys from `anchor` to `target`, both included, in list order. */
export declare function rangeKeys(keys: string[], anchor: string | null, target: string): string[];
/** What a "select all" box shows for `checked` of `total` rows. */
export declare function allState(checked: number, total: number): 'true' | 'false' | 'mixed';
/** A list driven from the page, or new options for one the attribute path made. */
export declare function create(el: Element, options?: ListOptions): ListController;
/** Copy buttons after the values of a .ds-facts list. */
export declare function facts(el: Element): FactsController;
