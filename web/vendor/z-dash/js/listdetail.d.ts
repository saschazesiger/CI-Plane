/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.listdetail (src/components/listdetail/listdetail.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export type ListdetailLevel = 'list' | 'detail' | 'sub';

export interface ListdetailOptions {
  /** Where it starts (default 'list'). */
  level?: ListdetailLevel;
}

export interface ListdetailSetOptions {
  /** The trigger that opened the level: the focus comes back to it. */
  opener?: Element | null;
  /** false: no column enters (default true). */
  animate?: boolean;
  /** false: the focus stays where it is, even in a column that goes (default true). */
  focus?: boolean;
}

export interface ListdetailChange {
  level: ListdetailLevel;
  previous: ListdetailLevel;
}

export interface ListdetailController {
  get(): ListdetailLevel;
  set(next: ListdetailLevel | string, options?: ListdetailSetOptions): void;
  /** Up one level, from the current one or from `from`. */
  back(from?: ListdetailLevel): void;
  /** The levels whose columns show at this width. */
  visible(): ListdetailLevel[];
  on(type: 'change', fn: (detail: ListdetailChange) => void): () => void;
  /** Reads data-ds-listdetail again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The level a value names among those available, else 'list'. */
export declare function level(value: string | null | undefined, available?: string[]): ListdetailLevel;
/** The level above `current` ('list' stays 'list'). */
export declare function parent(current: string): ListdetailLevel;
/** How many columns fit in `width` and which levels show. */
export declare function arrange(
  width: number,
  current: string,
  options?: { list?: number; detail?: number; sub?: number; available?: string[] },
): { columns: 1 | 2 | 3; shown: ListdetailLevel[] };
/** A list-detail layout driven from the page. */
export declare function create(el: Element, options?: ListdetailOptions): ListdetailController;
