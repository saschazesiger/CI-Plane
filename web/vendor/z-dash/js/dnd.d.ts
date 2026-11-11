/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.dnd (js/dnd.js). Hand-written; test/build.test.js keeps the
 * declared exports and their parameters equal to the module's.
 */

/** Where an item goes: a zone and its place among the zone's items without the dragged one. */
export interface DragTarget {
  zone: Element | null;
  index: number;
  /** For a custom target (a tree: 'before', 'inside', 'after'); part of what makes two targets differ. */
  position?: string;
  [key: string]: unknown;
}

export type DragMode = 'pointer' | 'keyboard' | 'api';

/** What target(), keyTarget() and place() get. */
export interface DragContext {
  item: Element;
  mode: DragMode;
  from: DragTarget;
  current: DragTarget;
  /** The zones the item can go to: never one inside itself. */
  zones: Element[];
  /** A zone's items in order. */
  itemsIn(zone: Element): Element[];
  /** Whether an item may go into a zone. */
  accepts(item: Element, zone: Element): boolean;
  /** Where an element sits without its translate or a running glide. */
  layoutBox(element: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

export interface DragAnnouncement {
  item: Element;
  zone: Element | null;
  label: string;
  zoneName: string;
  /** 1-based. */
  position: number;
  total: number;
}

export interface DragOptions {
  /** The items, a selector (default the zone's element children). */
  items?: string;
  /** Where a drag starts, a selector (default '.ds-grip'). */
  handle?: string;
  /** The drop zones in the container, a selector (default the container). */
  zones?: string;
  /** The element in a zone that holds its items, a selector (default the zone). */
  list?: string;
  /** How a zone's items run (default 'block'). */
  axis?: 'block' | 'inline' | 'both';
  /** Whether the item may go into the zone. */
  accept?: (item: Element, zone: Element) => boolean;
  /** An item's name in announcements (default its aria-label, else its text). */
  label?: (item: Element) => string;
  /** A zone's name in announcements (default its aria-label or aria-labelledby). */
  zoneLabel?: (zone: Element) => string;
  /** The text for each step; '' stays silent. Default the strings dragGrabbed ... of DS.core.config(). */
  announce?: (type: 'grab' | 'move' | 'drop' | 'cancel', detail: DragAnnouncement) => string;
  /** A pointer position to a target (null: none), instead of the list logic. */
  target?: (point: { x: number; y: number }, context: DragContext) => DragTarget | null;
  /** A key (arrows, Home, End) to a target, instead of the list logic. */
  keyTarget?: (key: string, context: DragContext) => DragTarget | null;
  /** Shows a target, instead of moving the item in the DOM. */
  place?: (target: DragTarget, context: DragContext) => void;
  /** Scroll an ancestor while the pointer is near its edge (default true). */
  autoScroll?: boolean;
}

export interface DragState {
  item: Element;
  mode: DragMode;
  from: DragTarget;
  to: DragTarget;
}

export interface DragController {
  /** The running drag, or null. */
  get(): DragState | null;
  /** Moves an item without a drag, with the events and the announcement of a drop; false when it did not move. */
  set(value: { item: Element; zone?: Element; index: number }): boolean;
  /** Ends a running drag, back where it came from. */
  cancel(): void;
  /** 'drag-start', 'drag-move', 'drop' or 'drag-cancel'; returns the unsubscribe. */
  on(type: 'drag-start' | 'drag-move' | 'drop' | 'drag-cancel', fn: (detail: any) => void): () => void;
  destroy(): void;
}

/** Moves items by pointer and keyboard inside `container`; once per container. */
export declare function create(container: Element | null | undefined, options?: DragOptions): DragController;
