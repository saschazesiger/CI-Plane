/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <TransferList> (react/transfer.js), generated from src/components/transfer/. */
import type { BehaviourComponent } from './shared.js';

export type TransferListVariant = never;

export interface TransferListEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TransferListOptions {
}

export declare const TransferList: BehaviourComponent<'div', TransferListVariant, TransferListEvents & TransferListOptions, ReturnType<typeof import('../js/transfer.js').create>>;
