/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.splitbutton (js/splitbutton.js). */

/** A split button's controller: the chosen variant of a menu of radio items (else null). */
export interface SplitButtonController {
  element: Element;
  action: Element | null;
  toggle: Element | null;
  menu: Element | null;
  get(): string | null;
  set(value: string): void;
  /** 'change' after a user's pick: { value, item }. Returns the unsubscribe. */
  on(type: 'change', fn: (detail: { value: string; item: Element }) => void): () => void;
  open(): Promise<void>;
  close(): Promise<void>;
  update(names: string[]): void;
  destroy(): void;
}

/** The parts of a split button: the action, the toggle and the menu. */
export declare function partsOf(group: Element): { action: Element | null; toggle: Element | null; menu: Element | null };
/** A split button driven from the page; the controller data-ds-splitbutton makes. */
export declare function create(group: Element, options?: { value?: string | null }): SplitButtonController;
