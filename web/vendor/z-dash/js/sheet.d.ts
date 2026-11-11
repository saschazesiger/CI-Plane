/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.sheet (js/sheet.js). */
import type { CloseReason, OpenOptions, OverlayController } from './overlay.js';

/** The bounds of a panel's width, in px. */
export interface WidthBounds {
  min: number;
  max: number;
}

/** The controller of a resizable panel. */
export interface ResizeController {
  element: Element;
  /** The width set or remembered, in px; null at the default width. */
  get(): number | null;
  /** Sets the width (within its bounds) and remembers it; null goes back to the default. */
  set(value: number | null): void;
  /** Hears `ds:resize` ({ width }); returns the unsubscribe. */
  on(type: 'resize' | string, fn: (event: CustomEvent<{ width: number }>) => void): () => void;
  destroy(): void;
}

/** The narrowest a panel goes, and the least it leaves the page or list beside it (px). */
export declare const MIN_WIDTH: number;

/** Opens a side sheet or a docked panel: DS.overlay.open(). */
export declare function open(element: Element, options?: OpenOptions): Promise<void>;
/** Closes a side sheet or a docked panel: DS.overlay.close(). */
export declare function close(element: Element, options?: { reason?: CloseReason }): Promise<void>;
/** The width within bounds, whole pixels. */
export declare function clampWidth(width: number, bounds: WidthBounds): number;
/** The width a drag gives: `start` plus the pointer's travel towards the separator's side, within bounds. */
export declare function dragWidth(start: number, delta: number, side: 'left' | 'right', bounds: WidthBounds): number;
/** Makes a panel resizable through its .ds-sheet__resize; remembers the width under `remember` (DS.store, namespace "sheet"). */
export declare function resizable(element: Element, options?: { remember?: string; min?: number; max?: number }): ResizeController | null;
/** The controller of a side sheet or docked panel, the one [data-ds-sheet] makes. */
export declare function create(element: Element): OverlayController;
