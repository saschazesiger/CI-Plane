/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.tabs (src/components/tabs/tabs.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export interface TabsOptions {
  /** Hide the tabs that do not fit the .ds-tabs__bar and list them in a "More" menu (default false). */
  overflow?: boolean;
  /** 'focus' (default): the arrow keys select; 'manual': they move the focus, Enter or Space selects. */
  activate?: 'focus' | 'manual';
}

export interface TabsChange {
  tab: HTMLElement;
  panel: HTMLElement | null;
  previous: HTMLElement | null;
  /** The new tab's id, or null. */
  value: string | null;
  /** Whether the panel shows for the first time. */
  first: boolean;
}

export interface TabsClose {
  tab: HTMLElement;
  panel: HTMLElement | null;
}

export interface TabsAddSpec {
  label: string;
  id?: string;
  /** A close button beside it and Delete (default true). */
  closable?: boolean;
  /** Select and focus it (default true). */
  select?: boolean;
  /** Its panel; default a .ds-tabs__panel after the last panel, holding the named close action (data-ds-tabs-close) when the tab closes. */
  panel?: HTMLElement;
}

export interface TabsController {
  /** The id of the selected (or current) tab, or null. */
  get(): string | null;
  /** Selects a tab by id or element; whether the selection changed. */
  set(value: string | Element): boolean;
  on(type: 'change', fn: (detail: TabsChange) => void): () => void;
  on(type: 'close', fn: (detail: TabsClose) => void): () => void;
  on(type: 'add', fn: (detail: Record<string, never>) => void): () => void;
  select(target: string | Element | null, how?: { focus?: boolean; animate?: boolean }): boolean;
  /** Closes a tab and its panel unless ds:close is cancelled; whether it closed. */
  close(tab: Element): boolean;
  add(spec: TabsAddSpec): { tab: HTMLElement; panel: HTMLElement };
  /** Lays the row out again. */
  refresh(): void;
  destroy(): void;
}

/** Which slots stay in a row of `room` px: in order while they fit, the selected one always. */
export declare function fit(widths: number[], options: { room: number; gap?: number; pad?: number; selected?: number }): number[];
/** A row of tabs driven from the page. */
export declare function create(el: HTMLElement, options?: TabsOptions): TabsController;
