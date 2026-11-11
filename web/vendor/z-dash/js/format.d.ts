/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.format (js/format.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 */

export interface FormatOptions {
  /** A BCP 47 locale; default DS.core.config().locale. */
  locale?: string;
  /** What an empty value or something that is no number or date gives (default ''). */
  empty?: string;
}

export type NumberOptions = FormatOptions & Intl.NumberFormatOptions;

export interface BytesOptions extends NumberOptions {
  /** 1000 (default: kB, MB through Intl units) or 1024 (KiB, MiB). */
  base?: 1000 | 1024;
  /** Default 1, none for whole bytes. */
  maximumFractionDigits?: number;
}

export type DurationUnit = 'day' | 'hour' | 'minute' | 'second' | 'millisecond';

export interface DurationOptions extends FormatOptions {
  /** 'short' (default), 'long', 'narrow' or 'clock' (1:02:03). */
  style?: 'short' | 'long' | 'narrow' | 'clock';
  /** How many units at most (default 2); the last one is rounded. */
  parts?: number;
  /** The smallest unit (default 'second'; under a second 'millisecond' unless named). */
  smallest?: DurationUnit;
}

export interface ListOptions extends FormatOptions {
  type?: 'conjunction' | 'disjunction' | 'unit';
  style?: 'long' | 'short' | 'narrow';
}

export interface PluralOptions extends NumberOptions {
  /** 'cardinal' (default) or 'ordinal'. */
  type?: 'cardinal' | 'ordinal';
}

/** A form of plural(): a text with {count}, or a function of the count. */
export type PluralForm = string | ((vars: { count: number; formatted: string }) => string);

export type RelativeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface RelativeOptions extends FormatOptions {
  /** What "now" is (default this moment). */
  now?: Date | number;
  style?: 'long' | 'short' | 'narrow';
  /** 'auto' (default: 'yesterday', 'now') or 'always' ('1 day ago'). */
  numeric?: 'auto' | 'always';
  /** The smallest unit it goes down to (default 'second'). */
  smallest?: RelativeUnit;
  /** The largest unit it goes up to (default 'year'). */
  largest?: RelativeUnit;
}

export type DateValue = Date | number | string;

export interface TimeOptions {
  /** The date to start from; written to the element. */
  value?: DateValue;
  style?: RelativeOptions['style'];
  numeric?: RelativeOptions['numeric'];
  smallest?: RelativeUnit;
  largest?: RelativeUnit;
  /** false: no absolute date in data-tip (as data-ds-time-tip="off"). */
  tip?: boolean;
  locale?: string;
}

export interface TimeDetail {
  value: Date | null;
  text: string;
}

export interface TimeController {
  /** The date and the text showing. */
  get(): TimeDetail;
  /** Writes a new date (to data-ds-time, or datetime on a <time>). */
  set(value: DateValue | null): void;
  /** Runs when the text changed; returns the unsubscribe. No event bubbles on a tick. */
  on(type: 'change', fn: (detail: TimeDetail) => void): () => void;
  /** Reads the attributes again and writes the text now. */
  update(): void;
  destroy(): void;
}

/** A number through Intl.NumberFormat. */
export declare function number(value: number | bigint | string | null | undefined, options?: NumberOptions): string;
/** A share as a percentage: 0.42 gives 42%. */
export declare function percent(value: number | string | null | undefined, options?: NumberOptions): string;
/** An amount of money in the ISO 4217 currency `code`. */
export declare function currency(value: number | string | null | undefined, code: string, options?: NumberOptions): string;
/** A size in bytes in the largest unit that keeps a figure of at least 1. */
export declare function bytes(value: number | string | null | undefined, options?: BytesOptions): string;
/** A length of time given in ms. */
export declare function duration(value: number | string | null | undefined, options?: DurationOptions): string;
/** Items as a sentence through Intl.ListFormat; empty items are left out. */
export declare function list(items: Iterable<unknown> | null | undefined, options?: ListOptions): string;
/** The form of `forms` for `count`: an exact '=0', the plural category, then `other`. */
export declare function plural(count: number, forms: Record<string, PluralForm>, options?: PluralOptions): string;
/** How far a date is from now: '3 minutes ago', 'in 2 hours', 'yesterday'. */
export declare function relative(value: DateValue | null | undefined, options?: RelativeOptions): string;
/** A full date and time for a tooltip or a title; default a medium date and a short time. */
export declare function absolute(value: DateValue | null | undefined, options?: FormatOptions & Intl.DateTimeFormatOptions): string;
/** Adds `fn` to the page's one clock and runs it now; returns the function that takes it off. */
export declare function clock(fn: (now: number) => number | void): () => void;
/** Keeps the relative time of `el` current on the shared clock; once per element. */
export declare function time(el: Element | null | undefined, options?: TimeOptions): TimeController;
