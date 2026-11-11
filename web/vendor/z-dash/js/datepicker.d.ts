/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.datepicker (js/datepicker.js): the date and the date-time picker. */
import type { DisabledRule } from './calendar.js';
import type { ChangeDetail } from './datefield.js';

export interface DatepickerOptions {
  type?: 'date' | 'datetime';
  value?: string | null;
  min?: string;
  max?: string;
  disabled?: DisabledRule;
  weeks?: boolean;
  /** The zone of a datetime's wall time: 'local' or an IANA name. */
  zone?: string;
  /** Minutes between the listed times of a datetime (default 30). */
  step?: number;
  name?: string;
  hourCycle?: 'h12' | 'h23';
  locale?: string;
}

export interface DatepickerController {
  element: Element;
  get(): string;
  set(value: string | null): string;
  instant(): Date | null;
  open(): Promise<void>;
  close(): Promise<void>;
  on(type: 'change' | 'open' | 'close', fn: (detail: ChangeDetail & { reason?: string }) => void): () => void;
  destroy(): void;
}

/** The date picker's controller, the one [data-ds-datepicker] makes. */
export declare function create(root: Element, options?: DatepickerOptions): DatepickerController;
