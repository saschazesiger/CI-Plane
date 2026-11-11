/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.datagrid (src/components/grid/grid.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export type SortDirection = 'ascending' | 'descending';

export interface GridSort {
  key: string;
  dir: SortDirection;
}

export type GridSummary = 'sum' | 'avg' | 'min' | 'max' | 'count' | ((rows: any[]) => number | string | null);

export interface GridEdit {
  /** 'text' (default), 'number' or 'select'. */
  type?: 'text' | 'number' | 'select';
  /** The choices of a 'select' editor: values, or { value, label }. */
  options?: Array<string | number | { value: string | number; label?: string }>;
  /** An empty value is refused with the string valueRequired. */
  required?: boolean;
  /** Returns the words that refuse a value, or '' to take it. */
  validate?: (value: any, row: any) => string | null | undefined | false;
}

export interface GridColumn {
  key: string;
  /** The column's name: header, chooser, export, stacked label (default the key). */
  label?: string;
  /** Markup of the header label (default the escaped label). */
  head?: string;
  /** 'text' (default), 'number' (.ds-num, numeric sort) or 'date'. */
  type?: 'text' | 'number' | 'date';
  /** The value of a row (default row[key]). */
  value?: (row: any) => any;
  /** What sorts (default value()). */
  sortValue?: (row: any) => any;
  /** The value as text (default Intl for numbers and dates). */
  format?: (value: any, row: any) => string;
  /** The cell's markup, escaped by the page (default the escaped text). */
  render?: (row: any, column: GridColumn) => string;
  /** Writes an edited value (default row[key] = value). */
  set?: (row: any, value: any) => void;
  /** Classes of the column's cells (default .ds-num for numbers). */
  className?: string;
  /** Classes of the header cell (default className). */
  headClass?: string;
  sortable?: boolean;
  resizable?: boolean;
  reorderable?: boolean;
  hideable?: boolean;
  hidden?: boolean;
  filterable?: boolean;
  /** false: left out of CSV and copies. */
  export?: boolean;
  /** The text an export writes instead of the formatted value. */
  exportValue?: (row: any) => string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  summary?: GridSummary;
  summaryFormat?: (value: any) => string;
  edit?: boolean | 'text' | 'number' | 'select' | GridEdit;
}

export interface GridQuery {
  sort: GridSort[];
  filter: any;
  page: { index: number; size: number } | null;
}

export interface GridResult {
  rows: any[];
  total?: number;
  summary?: Record<string, number | string | null>;
}

export interface GridOptions {
  columns?: Array<GridColumn | string>;
  /** Client data: filtered, sorted, grouped and paged by the grid. */
  rows?: any[];
  /** Server data: called with the query; returns (a promise of) the page of rows. */
  /** Server data. An export asks for every row: `page` null and `export: true` in the context. */
  source?: (query: GridQuery, context: { signal: AbortSignal; export?: boolean }) => GridResult | any[] | Promise<GridResult | any[]>;
  /** A row's key: a property name (default 'id') or a function. */
  key?: string | ((row: any, index: number) => string);
  /** Names a row (checkbox labels, announcements; default its first column's text). */
  label?: (row: any) => string;
  sort?: GridSort | GridSort[];
  /** Columns sort without sortable: true of their own. */
  sortable?: boolean;
  /** Shift adds a column to the sort. */
  multiSort?: boolean;
  filter?: string | ((row: any) => boolean) | Record<string, any> | null;
  page?: { index?: number; size?: number } | null;
  select?: 'multiple' | 'single' | boolean;
  selected?: Iterable<string>;
  /** The .ds-selection-bar the grid drives (an element or a selector). */
  bar?: Element | string;
  /** The .ds-pagination the grid drives. */
  pager?: Element | string;
  /** The .ds-menu the grid fills with presets and columns. */
  chooser?: Element | string;
  presets?: Array<{ id?: string; label: string; columns: string[] }>;
  /** The .ds-menu of a row (right click, Shift+F10, a [data-ds-datagrid-menu] button). */
  menu?: Element | string;
  actions?: (row: any) => string;
  detail?: (row: any) => string;
  expanded?: Iterable<string>;
  tree?: boolean | { children?: string | ((row: any) => any[]) };
  group?: string | { by: string } | null;
  collapsed?: Iterable<string>;
  focus?: 'cell' | 'row' | false;
  resize?: boolean;
  reorder?: boolean;
  edit?: boolean;
  virtual?: boolean | { estimate?: number; overscan?: number };
  /** A DS.store namespace: order, visibility, widths, sort and page size are remembered. */
  persist?: string;
  foot?: boolean;
  footLabel?: string;
  emptyText?: string;
  loadingText?: string;
  errorText?: string;
  file?: string;
  rowClass?: (row: any) => string;
}

export interface GridSelection {
  count: number;
  keys: string[];
  /** Every row that passes the filter, across pages, but `except`. */
  all: boolean;
  except: string[];
}

export interface GridState {
  sort: GridSort[];
  filter: any;
  page: { index: number; size: number; pages: number } | null;
  selection: GridSelection;
  columns: { order: string[]; hidden: string[]; widths: Record<string, number> };
  expanded: string[];
  total: number;
  status: 'idle' | 'loading' | 'error';
  rows: any[];
}

export interface GridController {
  get(): GridState;
  set(value: Partial<{ rows: any[]; sort: GridSort | GridSort[]; filter: any; page: number | { index?: number; size?: number }; group: string | { by: string } | null; selected: Iterable<string>; expanded: Iterable<string>; columns: Partial<{ order: string[]; hidden: string[]; widths: Record<string, number> }> }>): void;
  on(type: 'sort' | 'filter' | 'page' | 'select' | 'expand' | 'edit' | 'columns' | 'menu' | 'action' | 'load' | 'error', fn: (detail: any) => void): () => void;
  refresh(): void | Promise<void>;
  select(keys: Iterable<string> | 'all' | 'page' | 'none' | null): void;
  expand(key: string, open?: boolean): boolean;
  edit(key: string, column: string): boolean;
  focus(key?: string, column?: string): void;
  sort(key: string, dir?: SortDirection): void;
  page(index: number): void;
  preset(id: string): void;
  toggleColumn(key: string, show?: boolean): void;
  resize(key: string, width: number): void;
  /** The CSV text; with `source`, a promise of it (every row comes from the source again). */
  csv(options?: { selected?: boolean; separator?: string; header?: boolean }): string | Promise<string>;
  copy(options?: { selected?: boolean; header?: boolean }): Promise<boolean>;
  /** Saves the CSV and returns its text; with `source`, a promise of it. */
  download(name?: string, options?: { selected?: boolean; separator?: string; header?: boolean }): string | Promise<string>;
  menu(key: string, options?: { x?: number; y?: number; opener?: Element | null }): boolean;
  destroy(): void;
}

/** One summary of rows in a column: 'sum', 'avg', 'min', 'max', 'count' or the column's function. */
export declare function summary(rows: any[], column: GridColumn): number | string | null;
/** The client pipeline without a DOM: filter, sort, group or tree, page. */
export declare function query(rows: any[], options?: {
  columns?: Array<GridColumn | string>;
  sort?: GridSort | GridSort[];
  filter?: any;
  page?: { index?: number; size?: number } | null;
  key?: string | ((row: any, index: number) => string);
  tree?: boolean | { children?: string | ((row: any) => any[]) } | null;
  expanded?: Iterable<string>;
  group?: string | { by: string } | null;
  collapsed?: Iterable<string>;
  locale?: string;
}): { items: any[]; rows: any[]; total: number; filtered: any[] };
/** Rows as CSV (RFC 4180), with a header line; formula starts defused. */
export declare function csv(rows: any[], columns: Array<GridColumn | string>, options?: { separator?: string; header?: boolean; safe?: boolean; raw?: boolean; locale?: string }): string;
/** The grid of a table (the controller data-ds-datagrid makes). */
export declare function create(table: HTMLTableElement, options?: GridOptions): GridController;
