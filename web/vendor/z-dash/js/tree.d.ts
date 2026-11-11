/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.tree (src/components/tree/tree.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

/** One item as data, for a loader (lazy children) to return. */
export interface TreeItemData {
  /** Its key (data-ds-key). */
  id?: string | number;
  label: string;
  /** A glyph name of DS.icons; a folder without one shows folder and folderOpen. */
  icon?: string;
  /** A short fact at the row's end (a count, a size). */
  meta?: string;
  /** The label becomes a link: relative, #, http(s) or mailto (any other is dropped). */
  href?: string;
  /** Child items, or true: a lazy folder whose children load when it opens. */
  children?: TreeItemData[] | true;
  expanded?: boolean;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
}

/** What a loader may return (or resolve to): markup, nodes, or data. */
export type TreeContent = string | Node | Iterable<Node | TreeItemData>;

export interface TreeOptions {
  /** 'single' (default): one chosen row; 'checkbox': tri-state checks; 'none': open and activate only. */
  select?: 'single' | 'checkbox' | 'none';
  /** Lazy children of an item with data-ds-tree-lazy. */
  load?: (item: Element, context: { key: string | null; signal: AbortSignal }) => TreeContent | Promise<TreeContent>;
  /** Move items by their grip (DS.dnd). */
  drag?: boolean;
  /** Whether a place takes the item: folder is the folder item, or null for the top level. */
  accept?: (item: Element, folder: Element | null) => boolean;
}

export interface TreeEvent {
  item: Element;
  key: string | null;
}

export interface TreeController {
  /** Single: the selected key; checkbox: the checked keys; none: the active key. */
  get(): string | string[] | null;
  set(value: string | string[] | null): void;
  on(type: 'toggle', fn: (detail: TreeEvent & { expanded: boolean }) => void): () => void;
  on(type: 'select' | 'activate' | 'load', fn: (detail: TreeEvent) => void): () => void;
  on(type: 'change', fn: (detail: TreeEvent & { checked: boolean; keys: string[] }) => void): () => void;
  on(type: 'error', fn: (detail: TreeEvent & { error: unknown }) => void): () => void;
  on(type: string, fn: (detail: any) => void): () => void;
  /** Opens (or closes) a folder by key or element, loading a lazy one first; resolves to whether it did. */
  expand(target: string | Element, open?: boolean): Promise<boolean>;
  /** Opens every loaded folder, or closes every one. */
  expandAll(open?: boolean): void;
  /** Checks or unchecks an item with its subtree (checkbox); toggles without a value. */
  check(target: string | Element, value?: boolean): boolean;
  /** Focuses an item, opening the folders above it. */
  focus(target: string | Element): void;
  /** The item of a key, or null. */
  item(key: string): Element | null;
  /** Loads a folder's children again through the loader. */
  reload(target: string | Element): Promise<boolean>;
  /** New options. */
  configure(options?: TreeOptions): void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The state a folder shows for its children's: 'true', 'false', 'mixed', or null without children. */
export declare function checkState(states: Iterable<string | null | undefined>): 'true' | 'false' | 'mixed' | null;
/** A tree driven from the page, or new options for one the attribute path made. */
export declare function create(el: Element, options?: TreeOptions): TreeController;
