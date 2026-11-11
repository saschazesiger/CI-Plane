/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.datefield (js/datefield.js): the segmented date, time, date-time and range field. */
import type { DisabledRule } from './calendar.js';

export type FieldType = 'date' | 'time' | 'datetime' | 'range';

export interface DatefieldOptions {
  type?: FieldType;
  /** ISO text of the type: 2026-11-04, 09:30, 2026-11-04T09:30, 2026-11-01/2026-11-07. */
  value?: string | null;
  min?: string;
  max?: string;
  /** Blocked days, as DS.calendar.available() reads them (a function, or ISO dates, ranges and weekdays): such a day is invalid. */
  disabled?: DisabledRule;
  /** The name of a hidden input that carries the value in a form. */
  name?: string;
  seconds?: boolean;
  hourCycle?: 'h12' | 'h23';
  /** The zone of a datetime's wall time: 'local' or an IANA name; shows its hint. */
  zone?: string;
  locale?: string;
  /** The page's own verdict: aria-invalid holds whatever the value (a range checked across two fields). */
  invalid?: boolean;
  /** No ds: events on the element, only on() listeners (a picker sends its own). */
  silent?: boolean;
}

export interface ChangeDetail {
  value: string;
  valid: boolean;
}

export interface DatefieldController {
  element: Element;
  get(): string;
  set(value: string | null, options?: { emit?: boolean }): string;
  valid(): boolean;
  instant(): Date | null;
  focus(key?: string): void;
  update(options?: DatefieldOptions): void;
  on(type: 'change', fn: (detail: ChangeDetail) => void): () => void;
  destroy(): void;
}

export interface LayoutPart {
  type: string;
  value?: string;
  group?: 'start' | 'end';
}

/** The hour cycle of a locale as 'h12' or 'h23'; `wanted` overrides it. */
export declare function hourCycle(locale?: string, wanted?: string): 'h12' | 'h23';
/** The parts of a field in the locale's order. */
export declare function layout(type: FieldType, locale?: string, options?: { hourCycle?: string; seconds?: boolean }): LayoutPart[];
/** A zone for people: its offset and its long name. */
export declare function zoneName(timeZone?: string, options?: { locale?: string; at?: Date }): { id: string; short: string; long: string };
/** The instant of a wall time in a zone. */
export declare function toInstant(value: string, timeZone?: string): Date | null;
/** One digit typed into a numeric segment. */
export declare function typeDigit(input: { min: number; max: number; typed: string; digit: string; size?: number }): { value: number | null; typed: string; done: boolean };
/** The field's controller, the one [data-ds-datefield] makes. */
export declare function create(element: Element, options?: DatefieldOptions): DatefieldController;
