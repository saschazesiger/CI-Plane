/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Transcript> (react/transcript.js), generated from src/components/transcript/. */
import type { BehaviourComponent } from './shared.js';

export type TranscriptVariant = never;

export interface TranscriptEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:earlier on the root. */
  onDsEarlier?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TranscriptOptions {
}

export declare const Transcript: BehaviourComponent<'div', TranscriptVariant, TranscriptEvents & TranscriptOptions, ReturnType<typeof import('../js/transcript.js').create>>;
