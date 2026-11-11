/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.timepicker (js/timepicker.js): the time picker and its list of times. */
import type { ChangeDetail } from './datefield.js';

export interface TimesOptions {
  /** Minutes between the listed times (default 30). */
  step?: number;
  /** 'HH:mm'. */
  min?: string;
  max?: string;
}

export interface TimeListOptions extends TimesOptions {
  value?: string;
  hourCycle?: 'h12' | 'h23';
  locale?: string;
  label?: string;
  onSelect?: (value: string) => void;
}

export interface TimeList {
  element: Element;
  get(): string;
  set(value: string | null): string;
  update(options?: TimeListOptions): void;
  reveal(): void;
  focus(): void;
  destroy(): void;
}

export interface TimepickerOptions extends TimesOptions {
  value?: string;
  hourCycle?: 'h12' | 'h23';
  seconds?: boolean;
  name?: string;
  locale?: string;
}

export interface TimepickerController {
  element: Element;
  get(): string;
  set(value: string | null): string;
  open(): Promise<void>;
  close(): Promise<void>;
  on(type: 'change' | 'open' | 'close', fn: (detail: ChangeDetail & { reason?: string }) => void): () => void;
  destroy(): void;
}

/** The times of a day from min to max, every step minutes, as 'HH:mm'. */
export declare function times(options?: TimesOptions): string[];
/** The list of times alone, in `element`. */
export declare function list(element: Element, options?: TimeListOptions): TimeList;
/** The time picker's controller, the one [data-ds-timepicker] makes. */
export declare function create(root: Element, options?: TimepickerOptions): TimepickerController;
