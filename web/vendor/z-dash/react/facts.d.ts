/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Facts> (react/facts.js), generated from src/components/list/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type FactsVariant = 'bordered' | 'grid' | 'rows' | 'stacked';

export interface FactsEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:copy on the root. */
  onDsCopy?: (event: CustomEvent) => void;
  /** ds:drop on the root. */
  onDsDrop?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface FactsOptions {
}

export declare const Facts: BehaviourComponent<'dl', FactsVariant, FactsEvents & FactsOptions, Controller>;
