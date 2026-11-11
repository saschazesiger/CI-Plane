/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.bottomsheet (js/bottomsheet.js). */
/** Where a bottom sheet is. */
export interface BottomSheetState {
  open: boolean;
  /** The detent it rests at, a fraction of its full height. */
  detent: number;
  index: number;
}

/** The controller of a bottom sheet. */
export interface BottomSheetController {
  element: Element;
  get(): BottomSheetState;
  /** Opens (true) or closes (false) it, or moves it to a detent (a fraction of its list, or { index }). */
  set(value: boolean | number | { index?: number }): Promise<void>;
  /** Hears ds:detent ({ detent, index }), ds:open and ds:close; returns the unsubscribe. */
  on(type: string, fn: (event: Event) => void): () => void;
  destroy(): void;
  /** The detent the next open starts at (DS.bottomsheet.open() sets it). */
  want(index: number | null): void;
}

/** The detents of an attribute value: fractions in (0, 1], sorted, once each; none gives [1]. */
export declare function parseDetents(value: string | null | undefined): number[];
/** The detent a release reaches (its index), or -1 to close. */
export declare function settleDetent(detents: number[], shown: number, velocity: number, projection: number): number;
/** The controller of a bottom sheet, the one [data-ds-bottomsheet] makes. */
export declare function create(element: Element): BottomSheetController;
/** Opens a bottom sheet at `detent` (default the smallest): DS.overlay.open(). */
export declare function open(element: Element, options?: {
  /** The element focus returns to (DS.overlay.open's opener). */
  opener?: Element | null;
  /** Where focus goes on close when the opener is gone. */
  returnTo?: () => Element | null | undefined;
  /** The detent index to open at; default the smallest. */
  detent?: number;
}): Promise<void>;
/** Closes a bottom sheet: DS.overlay.close(). */
export declare function close(element: Element, options?: { reason?: string }): Promise<void>;
