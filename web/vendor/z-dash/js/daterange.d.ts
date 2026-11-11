/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.daterange (js/daterange.js): the date range picker and its relative presets. */
import type { DisabledRule } from './calendar.js';

export interface DaterangeOptions {
  /** '<start>/<end>' or a preset: today, yesterday, last-<n>-days, this-week, last-week, this-month, last-month, this-year, last-year. */
  value?: string | null;
  /** The presets offered ([] for none). */
  presets?: string[];
  min?: string;
  max?: string;
  disabled?: DisabledRule;
  weeks?: boolean;
  name?: string;
  locale?: string;
}

export interface RangeDetail {
  /** The preset in force, else '<start>/<end>'. */
  value: string;
  start: string;
  end: string;
  preset: string;
  valid: boolean;
}

export interface DaterangeController {
  element: Element;
  get(): string;
  set(value: string | null): string;
  range(): { start: string; end: string; preset: string };
  open(): Promise<void>;
  close(): Promise<void>;
  on(type: 'change' | 'open' | 'close', fn: (detail: RangeDetail & { reason?: string }) => void): () => void;
  destroy(): void;
}

/** The range a preset stands for today (or on `today`). */
export declare function resolve(preset: string, options?: { today?: string; locale?: string; firstDay?: number }): { start: string; end: string } | null;
/** The name of a preset for people. */
export declare function presetLabel(preset: string, options?: { locale?: string }): string;
/** The date range picker's controller, the one [data-ds-daterange] makes. */
export declare function create(root: Element, options?: DaterangeOptions): DaterangeController;
