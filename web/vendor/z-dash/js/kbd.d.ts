/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.kbd (src/components/kbd/kbd.js). Hand-written; the build test
 * keeps the declared exports and their parameters equal to the module's.
 */

export interface KbdKeys {
  /** One entry per combo of a sequence: the key labels and the one line. */
  combos: { keys: string[]; text: string }[];
  /** The keys in words, for a screen reader ("Shift Command K"). */
  spoken: string;
  /** The value of aria-keyshortcuts for the control the shortcut presses. */
  aria: string;
  /** Whether it was written for an Apple system. */
  apple: boolean;
}

export interface KbdState {
  combo: string;
  spoken: string;
  aria: string;
}

export interface KbdController {
  get(): KbdState;
  set(next: string): void;
  on(type: 'change', fn: (detail: KbdState) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** A combo or a sequence as the keys of this platform; throws on a combo DS.hotkeys cannot read. */
export declare function keys(combo: string, options?: { apple?: boolean }): KbdKeys;
/** Keys driven from the page. */
export declare function create(el: Element, options?: { combo?: string; platform?: 'apple' | 'other' }): KbdController;
