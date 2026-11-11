/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <DataGrid> (react/datagrid.js), generated from src/components/datagrid/. */
import type { BehaviourComponent } from './shared.js';

export type DataGridVariant = 'bordered' | 'interactive' | 'pin-first' | 'pin-last' | 'plain' | 'stack' | 'stack-wide' | 'sticky-foot' | 'sticky-head' | 'wide' | 'zebra';

export interface DataGridEvents {
  /** ds:action on the root. */
  onDsAction?: (event: CustomEvent) => void;
  /** ds:columns on the root. */
  onDsColumns?: (event: CustomEvent) => void;
  /** ds:edit on the root. */
  onDsEdit?: (event: CustomEvent) => void;
  /** ds:error on the root. */
  onDsError?: (event: CustomEvent) => void;
  /** ds:expand on the root. */
  onDsExpand?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
  /** ds:load on the root. */
  onDsLoad?: (event: CustomEvent) => void;
  /** ds:menu on the root. */
  onDsMenu?: (event: CustomEvent) => void;
  /** ds:page on the root. */
  onDsPage?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
  /** ds:sort on the root. */
  onDsSort?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DataGridOptions {
}

export declare const DataGrid: BehaviourComponent<'table', DataGridVariant, DataGridEvents & DataGridOptions, ReturnType<typeof import('../js/datagrid.js').create>>;
