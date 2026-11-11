/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.calendar (js/calendar.js): the date engine of every picker, and the month grid. */

/** A date without a time or a time zone; month 1-12. */
export interface PlainDate {
  year: number;
  month: number;
  day: number;
}

/** The week of a locale: firstDay 1 (Monday) ... 7 (Sunday); minimalDays of the first week of a year (4: ISO 8601). */
export interface WeekInfo {
  firstDay: number;
  minimalDays: number;
}

/** What may not be picked: a test of the plain date, or a list (or comma text) of ISO dates, ranges ('a/b') and ISO weekdays (1-7). */
export type DisabledRule = ((date: PlainDate) => boolean) | Array<string | number> | string;

export interface Rules {
  min?: string | PlainDate | null;
  max?: string | PlainDate | null;
  disabled?: DisabledRule;
}

export interface CalendarOptions extends Rules {
  /** ISO text; in range mode '<start>/<end>', [start, end] or { start, end }. */
  value?: string | [string, string] | { start?: string; end?: string } | null;
  mode?: 'single' | 'range';
  /** 1 (default) or 2 months side by side. */
  months?: number;
  /** Week numbers in a column of their own. */
  weeks?: boolean;
  /** 1 (Monday) ... 7 (Sunday); default the locale's. */
  firstDay?: number;
  locale?: string;
  /** The month to show first (ISO text); default the value's or today's. */
  show?: string;
  /** Called after a pick with the new value. */
  onSelect?: (value: string) => void;
  /** No ds: events on the element (a picker sends its own). */
  silent?: boolean;
}

export interface CalendarController {
  element: Element;
  /** ISO text, or '<start>/<end>' in range mode; '' while none. */
  get(): string;
  set(value: CalendarOptions['value']): string;
  show(date: string | PlainDate): void;
  focus(date?: string | PlainDate): void;
  view(): { start: string; months: number; focus: string };
  update(options?: CalendarOptions): void;
  on(type: 'change' | 'input', fn: (detail: { value?: string; start?: string; end?: string }) => void): () => void;
  destroy(): void;
}

/** The days of a month (1-12). */
export declare function daysIn(year: number, month: number): number;
/** A plain date from ISO text, a Date or a plain date; null for anything else or a day that does not exist. */
export declare function parse(value: unknown): PlainDate | null;
/** The ISO text of a plain date, '' for none. */
export declare function iso(date: PlainDate | null | undefined): string;
/** Today: the local date, or the date in `timeZone`. */
export declare function today(options?: { timeZone?: string; now?: Date | number }): PlainDate;
/** A plain date moved by years, months and days; a month step keeps the day where it can. */
export declare function add(date: PlainDate, step: { years?: number; months?: number; days?: number }): PlainDate;
/** Negative when a is before b, 0 on the same day. */
export declare function compare(a: PlainDate, b: PlainDate): number;
/** The week of a locale, through Intl.Locale weekInfo or the table of regions. */
export declare function weekInfo(locale?: string, options?: { firstDay?: number }): WeekInfo;
/** The week of the year in the numbering of `info` (default ISO 8601). */
export declare function weekNumber(date: PlainDate, info?: WeekInfo): number;
/** Six weeks of plain dates around a month. */
export declare function grid(year: number, month: number, firstDay?: number): PlainDate[][];
/** Whether a day may be picked under `rules`. */
export declare function available(date: PlainDate, rules?: Rules): boolean;
/** A plain date for people through Intl (default the full date). */
export declare function label(date: PlainDate | string, options?: { locale?: string } & Intl.DateTimeFormatOptions): string;
/** A range of plain dates for people (Intl formatRange). */
export declare function rangeLabel(start: PlainDate | string, end: PlainDate | string, options?: { locale?: string } & Intl.DateTimeFormatOptions): string;
/** The calendar's controller, the one [data-ds-calendar] makes. */
export declare function create(element: Element, options?: CalendarOptions): CalendarController;
