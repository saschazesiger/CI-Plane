/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Tree> (react/tree.js), generated from src/components/tree/. */
import type { BehaviourComponent } from './shared.js';

export type TreeVariant = never;

export interface TreeEvents {
  /** ds:activate on the root. */
  onDsActivate?: (event: CustomEvent) => void;
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:drag-cancel on the root. */
  onDsDragCancel?: (event: CustomEvent) => void;
  /** ds:drag-move on the root. */
  onDsDragMove?: (event: CustomEvent) => void;
  /** ds:drag-start on the root. */
  onDsDragStart?: (event: CustomEvent) => void;
  /** ds:drop on the root. */
  onDsDrop?: (event: CustomEvent) => void;
  /** ds:error on the root. */
  onDsError?: (event: CustomEvent) => void;
  /** ds:load on the root. */
  onDsLoad?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
  /** ds:toggle on the root. */
  onDsToggle?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TreeOptions {
  /** data-ds-tree-select (true: present, false or none: absent). */
  select?: string | number | boolean | object | null;
  /** data-ds-tree-drag (true: present, false or none: absent). */
  drag?: string | number | boolean | object | null;
}

export declare const Tree: BehaviourComponent<'ul', TreeVariant, TreeEvents & TreeOptions, ReturnType<typeof import('../js/tree.js').create>>;
