/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.views (js/views.js). */

/** Filters, a sort and columns: what a view holds. */
export interface ViewState {
  /** Name to a list of strings (DS.filterbar.read()); a range is [min, max]. */
  filters?: Record<string, string[]>;
  /** A sort as DS.sort.stringify() writes it: "name", "-seen". */
  sort?: string;
  /** The columns shown, in order. */
  columns?: string[];
}

export interface ViewSummary {
  id: string;
  name: string;
  /** A view of the page (markup or options.views): it cannot be renamed, saved over or deleted. */
  builtin: boolean;
}

export interface ViewDetail {
  id: string;
  name: string;
  state: ViewState;
  reason: 'select' | 'delete';
}

export interface ViewsDetail {
  views: ViewSummary[];
  default: string | null;
  reason: 'save' | 'create' | 'rename' | 'default' | 'delete';
}

export interface ViewsController {
  get(): { id: string | null; name: string; state: ViewState; edited: boolean; default: string | null; views: ViewSummary[] };
  /** A view's id picks it; { state } is the page's current state ("Edited" when it differs); sends nothing. */
  set(value: string | { id?: string; state?: ViewState }): void;
  on(type: 'view', fn: (detail: ViewDetail) => void): () => void;
  on(type: 'views', fn: (detail: ViewsDetail) => void): () => void;
  /** Saves the state over the current view (a built-in one: as a new view); resolves its id. */
  save(): Promise<string | null>;
  /** A new view of the current state, named `name` (without one the user is asked). */
  create(name?: string): Promise<string | null>;
  /** Renames the current view (without a name the user is asked). */
  rename(name?: string): Promise<string | null>;
  /** Makes the current view the default. */
  setDefault(): Promise<string | null>;
  /** Copies the link to the current view (else shows it to copy); resolves the link. */
  share(): Promise<string>;
  /** Deletes the current view of the user; `ask` asks first. */
  remove(ask?: boolean): Promise<string | null>;
  /** The address with the current view and state. */
  link(): string;
  update(): void;
  destroy(): void;
}

/** A state as a query string (without "?"). */
export declare function toQuery(state: ViewState | null | undefined, options?: { prefix?: string; view?: string | null }): string;
/** The view and state a query string holds; null when it holds none of its parameters. */
export declare function fromQuery(search: string | URLSearchParams | null | undefined, options?: { prefix?: string }): { view: string | null; state: ViewState } | null;
/** The controller data-ds-views makes. */
export declare function create(
  el: Element,
  options?: { key?: string; url?: 'off' | 'read' | 'sync'; prefix?: string; views?: { id: string; name: string; state?: ViewState; default?: boolean }[] },
): ViewsController;
