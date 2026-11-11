/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.picker (js/picker.js): the popover of the date and time pickers. */

export interface PickerOptions {
  /** The button; default [data-ds-picker-toggle] or .ds-picker__toggle inside the root. */
  toggle?: Element | null;
  /** The panel; default the root's .ds-picker__popover (one is made when there is none). */
  panel?: Element | null;
  /** What it is placed at (default the root). */
  anchor?: Element | null;
  /** The panel's name when it has none. */
  label?: string;
  /** What takes focus on open. */
  focus?: () => Element | null | undefined;
  onOpen?: () => void;
  onClose?: (reason?: string) => void;
}

export interface PickerController {
  element: Element;
  panel: Element;
  toggle: Element | null;
  /** Whether it is open. */
  get(): boolean;
  set(value: boolean): Promise<void>;
  open(): Promise<void>;
  close(reason?: string): Promise<void>;
  place(): void;
  on(type: 'open' | 'close', fn: (detail: { reason?: string }) => void): () => void;
  destroy(): void;
}

/** The picker's controller, the one [data-ds-picker] makes. */
export declare function create(root: Element, options?: PickerOptions): PickerController;
/** Opens the picker of a root. */
export declare function open(root: Element): Promise<void>;
/** Closes the picker of a root. */
export declare function close(root: Element, options?: { reason?: string }): Promise<void>;
