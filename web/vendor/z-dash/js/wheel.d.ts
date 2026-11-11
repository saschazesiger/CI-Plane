/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.wheel (src/components/wheel/wheel.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export interface WheelOptions {
  /** The first text, shown at once (default ''). */
  text?: string;
  /** Every new line a .ds-shimmer (default false). */
  shimmer?: boolean;
}

export interface WheelChange {
  text: string;
}

export interface WheelController {
  get(): string;
  /** Rolls to `next`; `shimmer` overrides the option for this line. */
  set(next: string, options?: { shimmer?: boolean }): void;
  on(type: 'change', fn: (detail: WheelChange) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

export interface WheelHooks {
  onInsert(node: Element): void;
  onRemove(node: Element): Promise<void> | undefined;
}

/** The hooks of DS.dom.morphHtml() for .ds-wheel slots. */
export declare const hooks: Readonly<WheelHooks>;
/** When the next turn starts (ms on the clock of `at`). */
export declare function turnAt(restAt: number, at: number, hold: number, shown: boolean): number;
/** Rolls `slot` to a line of its own with `text`; resolves when it rests. */
export declare function roll(slot: Element | null | undefined, text: string, options?: { shimmer?: boolean }): Promise<void>;
/** A wheel driven from the page. */
export declare function create(slot: Element, options?: WheelOptions): WheelController;
