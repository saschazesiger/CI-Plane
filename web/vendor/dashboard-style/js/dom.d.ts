/**
 * Types of DS.dom (js/dom.js). Hand-written; test/build.test.js keeps the
 * declared exports and their parameters equal to the module's.
 */
import type { Destroyable } from './motion.js';

export interface MorphOptions {
  /** Replace instead of patching nodes whose shell differs. */
  replace?: boolean;
  /** Patch matched children only (no moves, inserts or removals). */
  holdOrder?: boolean;
  /** After a new element was inserted. */
  onInsert?: (node: Element) => void;
  /** Before an element goes; a Promise keeps it until it settles. */
  onRemove?: (node: Element) => Promise<unknown> | unknown;
  /** After a kept element was patched from `template`. */
  onKeep?: (kept: Element, template: Element) => void;
}
/** Patches the children of `target` to `nodes` in place. */
export declare function morphChildren(target: Node, nodes: Node[] | NodeList, options?: MorphOptions): void;
/** Patches the children of `target` to `html` in place (never innerHTML). */
export declare function morphHtml(target: Element, html: string, options?: MorphOptions): void;

export interface UpdateHandle extends Destroyable {
  update(): void;
}
/** Sets data-scrolled on `target` (default the scroller) while `scroller` is scrolled. */
export declare function watchScrolled(scroller: Element | null | undefined, target?: Element): UpdateHandle;
/** Writes data-ds-edges and the overflow attributes of a sideways (or vertical) scroller. */
export declare function scrollEdges(scroller: Element | null | undefined, options?: { axis?: 'inline' | 'block' }): UpdateHandle;
/** Sets a share (0 to 1, null for indeterminate) and its ARIA on a progress bar or spinner. */
export declare function progress<E extends Element>(el: E, share: number | null, options?: { valueText?: string; waiting?: boolean }): E;

export interface RovingOptions {
  items?: string;
  orientation?: 'horizontal' | 'vertical' | 'both';
  wrap?: boolean;
  activate?: 'focus' | 'manual' | false;
  onActivate?: (item: Element) => void;
}
/** One tab stop for a group; the arrow keys move between its items. */
export declare function roving(container: Element | null | undefined, options?: RovingOptions): Destroyable;
/** The app frame follows the on-screen keyboard, also for a field in a same-origin iframe (never in an embedded widget). */
export declare function followViewport(doc?: Document): Destroyable;
/** A log that sticks to its end while the reader is there. */
export declare function followEnd(scroller: Element | null | undefined, options?: { pill?: HTMLElement | null; threshold?: number }): Destroyable & { stick(): void };
/** A textarea that grows with its text. */
export declare function autosize(textarea: HTMLTextAreaElement | null | undefined): UpdateHandle;

export interface DropzoneOptions {
  onFiles: (files: File[], event: Event) => void;
  accept?: string;
  multiple?: boolean;
  paste?: boolean;
  target?: Element;
  /** The file input that hands its picks on too; absent: the zone's own, `null`: none (drops and paste only). */
  input?: HTMLInputElement | null;
}
/** Files dropped on (or pasted into) `zone`; data-ds-dragover while files hover. */
export declare function dropzone(zone: Element | null | undefined, options: DropzoneOptions): Destroyable;
