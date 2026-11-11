/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.menubutton (js/menubutton.js). */

/** A menu button's controller: the chosen value of a menu of radio items (else null). */
export interface MenuButtonController {
  element: Element;
  readonly menu: Element | null;
  get(): string | null;
  set(value: string): void;
  /** 'change' after a user's pick: { value, item }. Returns the unsubscribe. */
  on(type: 'change', fn: (detail: { value: string; item: Element }) => void): () => void;
  open(): Promise<void>;
  close(): Promise<void>;
  update(names: string[]): void;
  destroy(): void;
}

export interface MenuButtonOptions {
  menu?: Element | null;
  value?: string | null;
  label?: Element | null;
}

/** The menu a trigger names: the attribute's selector or id, else aria-controls, else the menu right after it. */
export declare function menuOf(button: Element, value?: string | null): Element | null;
/** An item's value: its value attribute, else data-value, else its label. */
export declare function itemValue(item: Element): string;
/** A menu button driven from the page; the controller data-ds-menubutton makes. */
export declare function create(button: Element, options?: MenuButtonOptions): MenuButtonController;
/** Opens the menu of a menu button (DS.overlay.open, the button as its opener). */
export declare function open(button: Element): Promise<void>;
/** Closes the menu of a menu button (DS.overlay.close). */
export declare function close(button: Element): Promise<void>;
