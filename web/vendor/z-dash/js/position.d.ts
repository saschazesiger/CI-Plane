/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.position (js/position.js), the shared placer. Hand-written;
 * test/build.test.js keeps the declared exports and their parameters equal
 * to the module's, and declares every `options.<name>` the module reads.
 */

export type Side = 'bottom' | 'top' | 'start' | 'end';
export type Align = 'start' | 'center' | 'end';
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface PlacementOptions {
  /** The side it leaves the anchor on (default 'bottom'). */
  side?: Side;
  /** Along the anchor (default 'start'). */
  align?: Align;
  /** The gap to the anchor, px. */
  offset?: number;
  /** The collision padding: what it keeps from the bounds, px. */
  padding?: number;
  /** The other side: with more room ('room', the default), only when it fits ('fits'), or never. */
  flip?: 'room' | 'fits' | false;
  /** The other edge when the wanted alignment leaves the bounds and that one fits. */
  crossFlip?: boolean;
  /** Keeps it inside the bounds along the anchor (default true). */
  shift?: boolean;
  /** Caps it to the room on its side (default true). */
  size?: boolean;
  /** Right to left: start and end swap. */
  rtl?: boolean;
  /** What the arrow keeps from the corners, px. */
  arrowPadding?: number;
}
export interface Placement {
  x: number;
  y: number;
  /** The side it took. */
  side: Side;
  flipped: boolean;
  /** The room on that side. */
  room: number;
  /** Its extent along that axis, capped to the room unless `size` is false. */
  length: number;
  /** The anchor's centre along the anchor, from its edge. */
  arrow: number;
}
/** A length in px, to two decimals. */
export declare function round(value: number): number;
/** A length token as computed on the element, in px. */
export declare function pxOf(element: Element, token: string, fallback: number): number;
/** Where a box goes: the geometry alone. */
export declare function computePlacement(rect: Bounds, size: { width: number; height: number }, bounds: Bounds, options?: PlacementOptions): Placement;
/** The viewport as the bounds of an element. */
export declare function viewportBounds(element: Element): Bounds;
/** The viewport, narrowed by every box around the element that clips its overflow. */
export declare function clippedBounds(element: Element): Bounds;
/** Where (0,0) of a fixed box's containing block sits in the viewport. */
export declare function fixedOrigin(element: Element): { left: number; top: number };
/** Takes the probe of fixedOrigin() out. */
export declare function dropProbe(element: Element): void;
export interface PlaceOptions extends Omit<PlacementOptions, 'rtl'> {
  /** Default: the viewport. */
  bounds?: Bounds;
  /** The custom properties that take its coordinates. */
  x?: string;
  y?: string;
}
/** Places a box at its anchor by the script. */
export declare function place(element: HTMLElement, anchor: Element, options?: PlaceOptions): Placement | null;
/** Top layer and CSS anchor positioning, both needed for the anchored path. */
export declare function supportsAnchoring(view: Window & typeof globalThis): boolean;
/** The anchor-name to point at an element, counted per user. */
export declare function claimAnchor(element: Element, nextName: () => string): { name: string; mine: boolean };
/** Lets go of a name claimAnchor() gave. */
export declare function releaseAnchor(element: Element | null | undefined): void;
/** Opens a box anchored in the top layer; true when the name is one to release. */
export declare function anchorPopup(element: HTMLElement, anchor: Element, options: { nextName: () => string; offset?: number }): boolean;
