/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.a11y (js/a11y.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 */
import type { Destroyable } from './motion.js';
import type { RovingOptions } from './dom.js';

/** Whether focus can land on the node as the page stands: canFocus(), not in a disabled fieldset, not unseen through visibility or content-visibility (a closed details). */
export declare function canTakeFocus(node: any): boolean;
/** The elements inside `root` that the Tab key stops at, in DOM order. */
export declare function tabbables(root: Element | null | undefined): HTMLElement[];
/** Whether plain keys typed on `node` already mean something: a field that takes text, a select, a widget with type-ahead. */
export declare function readsKeys(node: Element | null | undefined): boolean;

export interface TrapOptions {
  /** Where focus goes at once: an element or a selector; false leaves it. Default: [autofocus], else the first tabbable, else the container. */
  initial?: Element | string | false;
  /** Where focus goes on destroy(), when it is still inside or nowhere. Default: what had it before; false: nowhere. */
  returnFocus?: Element | false;
}
/** Keeps the Tab key inside `container` until destroy(); for a region that is no overlay. Once per container. */
export declare function trap(container: Element | null | undefined, options?: TrapOptions): Destroyable;
/** DS.dom.roving(): one tab stop for a group; the arrow keys move between its items. */
export declare function roving(container: Element | null | undefined, options?: RovingOptions): Destroyable;
/** The item the typed letters lead to, or null. `typed` is lower case; `label` gives the lower-case label of an item. */
export declare function typeaheadMatch(items: Element[], current: Element | null | undefined, typed: string, label?: (item: Element) => string): Element | null;

export interface TypeaheadOptions {
  /** A selector or a function. Default: every option, menu item, tree item, tab and radio. */
  items?: string | (() => Element[]);
  /** The lower-case label of an item. Default: its aria-label, else its text. */
  label?: (item: Element) => string;
  /** Replaces item.focus(). */
  onMatch?: (item: Element) => void;
  /** The item a search goes on from when focus is on none and the container has no aria-activedescendant. */
  current?: () => Element | null | undefined;
}
/** Typing a label moves focus to its item. Once per container. */
export declare function typeahead(container: Element | null | undefined, options?: TypeaheadOptions): Destroyable;
/** DS.overlay.announce(): says `text` to screen readers without showing anything. */
export declare function announce(text: string, options?: { assertive?: boolean; region?: Element | null; key?: string }): void;
/** DS.overlay.holdInert(): makes the elements inert until destroy(), for a modal region that is no overlay. */
export declare function inert(elements: Element | Iterable<Element> | null | undefined): Destroyable;
