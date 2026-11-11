/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.toggle (js/toggle.js). */

/** A toggle button's controller: get() whether it is on, set(on) from the page. */
export interface ToggleController {
  element: Element;
  get(): boolean;
  set(on: boolean): void;
  /** 'change' after a press: { pressed }. Returns the unsubscribe. */
  on(type: 'change', fn: (detail: { pressed: boolean }) => void): () => void;
  destroy(): void;
}

/** A toggle group's controller: the value that is on (single) or the values (multiple). */
export interface ToggleGroupController {
  element: Element;
  get(): string | null | string[];
  set(value: string | string[] | null): void;
  /** 'change' after a press: { value, item }. Returns the unsubscribe. */
  on(type: 'change', fn: (detail: { value: string | null | string[]; item: Element }) => void): () => void;
  update(names: string[]): void;
  destroy(): void;
}

export interface ToggleGroupOptions {
  mode?: 'single' | 'multiple';
  required?: boolean;
  value?: string | string[] | null;
  /** One tab stop with the arrow keys; default: the markup's data-ds-toggle-group-roving, else role="toolbar". */
  roving?: boolean;
}

/** The values a group's state names: single, one value or null; multiple, a list. */
export declare function parseValue(value: unknown, mode: 'single' | 'multiple'): string | null | string[];
/** The values that are on after a press on `item`. */
export declare function nextPressed(pressed: string[], item: string, options: { mode: 'single' | 'multiple'; required?: boolean }): string[];
/** A toggle button driven from the page; the controller data-ds-toggle makes (one per button: the same one twice). */
export declare function create(button: Element, options?: { pressed?: boolean }): ToggleController;
/** A toggle group driven from the page; the controller data-ds-toggle-group makes (one per group: the same one, options applied). */
export declare function group(element: Element, options?: ToggleGroupOptions): ToggleGroupController;
