/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.shell (src/components/shell/shell.js): the app frame, the
 * drawer, the phone search sheet, the launcher, the colour scheme switch
 * and the breadcrumbs. Hand-written; the build test keeps the declared
 * exports and their parameters equal to the module's.
 */

/** Where the top bar's search turns into a sheet: '(max-width: 720px)'. */
export declare const SEARCH_QUERY: string;

/** The controller shape every behaviour of this module shares. */
export interface ShellController<T, S = T> {
  element: Element;
  get(): T;
  set(value: S): unknown;
  /** Hears ds:<type> dispatched on the element itself; returns the unsubscribe. */
  on(type: string, fn: (detail: any) => void): () => void;
  destroy(): void;
}

export interface FrameOptions {
  /** The key the rail is remembered under (DS.store, namespace "shell"; default "app"). */
  key?: string;
  /** false: no rail; the menu button shows only with the modal drawer (default true). */
  rail?: boolean;
  /** false: nothing is stored (default true). */
  remember?: boolean;
}

export interface FrameState {
  /** The docked drawer is a rail (data-drawer-collapsed). */
  rail: boolean;
  /** The modal drawer is open (data-drawer-open). */
  open: boolean;
}

export interface DrawerOptions {
  /** The key the open groups are remembered under (default: the drawer's id, else "main"). */
  key?: string;
  /** false: nothing is stored (default true). */
  remember?: boolean;
}

export interface DrawerState {
  /** The filter's text ('' when none). */
  query: string;
  /** How many items the filter shows. */
  count: number;
  /** The keys of the open groups (id, data-ds-key, else the heading). */
  open: string[];
}

export interface DrawerChange {
  query?: string;
  /** Groups to open (true) or close (false), by key. */
  open?: Record<string, boolean>;
}

export interface SearchSheetOptions {
  /** The button that opens the sheet (default: the .ds-topbar__search-open of its top bar). */
  opener?: Element | null;
}

export type Scheme = 'light' | 'dark' | 'auto';

export interface SchemeOptions {
  /** The .ds-theme to pin (an element or a selector; default the one around the switch, else the page's first). */
  target?: Element | string;
  /** A dark theme's <link> whose media follows the choice (an element or a selector). */
  link?: Element | string;
  /** The key the choice is remembered under (default "scheme"). */
  key?: string;
  /** false: nothing is stored (default true). */
  remember?: boolean;
}

/** Whether `text` holds every word of `query`, in any case and without accents. */
export declare function matchText(text: string, query: string): boolean;
/** The frame of a .ds-app: menu button, rail, modal drawer, skip links, pill, edges and data-scrolled. */
export declare function create(app: Element, options?: FrameOptions): ShellController<FrameState, Partial<FrameState>>;
/** A .ds-drawer: remembered groups, the filter and the arrow keys. */
export declare function drawer(nav: Element, options?: DrawerOptions): ShellController<DrawerState, DrawerChange>;
/** The top bar's search as a full-width sheet at 720px and below. */
export declare function searchSheet(el: Element, options?: SearchSheetOptions): ShellController<boolean>;
/** The two-dimensional arrow keys of a .ds-menu.ds-launcher; get() is the current app, set(true|false) opens or closes it. */
export declare function launcher(menu: Element): ShellController<Element | null, boolean>;
/** Applies a colour scheme to a theme (and a dark link), remembered unless `remember` is false; null for an unknown value. */
export declare function setScheme(value: Scheme, options?: SchemeOptions): Scheme | null;
/** A switch of [data-ds-scheme-value] items. */
export declare function schemeSwitch(el: Element, options?: SchemeOptions): ShellController<Scheme>;
/** The crumbs to fold so the trail fits in `room`: indexes in order, empty when all fit. */
export declare function fitCrumbs(widths: number[], room: number, more: number): number[];
/** A .ds-breadcrumbs that folds what does not fit into a menu; get() lists the folded crumbs, set() measures again. */
export declare function breadcrumbs(nav: Element): ShellController<Element[], void>;
