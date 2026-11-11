/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Table> (react/table.js). */
import type * as React from 'react';
import type { Density, Size } from './shared.js';

export type SortDirection = 'ascending' | 'descending';

export interface TableColumn<Row> {
  /** The column's key: the row's field, and React's key. */
  key: string;
  /** The header cell's content. */
  header: React.ReactNode;
  /** .ds-num: right-aligned tabular figures (the sort arrow leads). */
  numeric?: boolean;
  /** .ds-col--secondary: dropped on phones. */
  secondary?: boolean;
  /** .ds-col--text: a readable width. */
  text?: boolean;
  /** .ds-nowrap. */
  nowrap?: boolean;
  /** A .ds-table__sort button in the header; onSort reports a press. */
  sortable?: boolean;
  /** The cell's content (default: row[key]). */
  render?: (row: Row, index: number) => React.ReactNode;
}

export type TableVariant = 'zebra' | 'bordered' | 'plain' | 'wide' | 'interactive' | 'pin-first' | 'pin-last';

export type TableProps<Row = any> = Omit<React.TableHTMLAttributes<HTMLTableElement>, 'className'> & {
  columns?: TableColumn<Row>[];
  rows?: Row[];
  /** A row's key (default row.id, else its index), also its data-ds-key. */
  rowKey?: (row: Row, index: number) => string | number;
  /** The table's name (a <caption>, visually hidden unless captionVisible). */
  caption?: React.ReactNode;
  captionVisible?: boolean;
  /** The sorted column: aria-sort and its arrow. */
  sort?: { key: string; direction?: SortDirection } | null;
  /** A press on a sortable header: the next direction. */
  onSort?: (key: string, direction: SortDirection) => void;
  variant?: TableVariant | TableVariant[];
  /** The wrapper becomes a focusable region with this name (cells without anything focusable). */
  wrapLabel?: string;
  size?: Size;
  density?: Density;
  className?: string;
  /** Without columns: your own <thead> and <tbody>. */
  children?: React.ReactNode;
};

export declare const Table: <Row = any>(props: TableProps<Row> & React.RefAttributes<HTMLTableElement>) => React.ReactElement | null;
