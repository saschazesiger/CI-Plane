/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.timerange (js/timerange.js): the time range with refresh. */

export interface TimeRange {
  /** now, now-15m, now/d, an ISO date or date-time, or milliseconds since 1970. */
  from: string;
  to?: string;
  /** '' (off) or a span: 5s, 1m, 1h. */
  refresh?: string;
}

export interface TimerangeOptions extends TimeRange {
  intervals?: string[];
  quick?: string[];
  /** The DS.store key of the recent ranges (default 'recent'). */
  store?: string;
  /** The zone of absolute times: 'local' or an IANA name. */
  zone?: string;
  locale?: string;
}

export interface TimerangeChange {
  from: string;
  to: string;
  start: string;
  end: string;
  label: string;
  query: string;
}

export interface TimerangeRefresh {
  from: string;
  to: string;
  start: string;
  end: string;
  reason: 'change' | 'manual' | 'interval';
}

export interface TimerangeController {
  element: Element;
  get(): { from: string; to: string; refresh: string };
  set(value: string | Partial<TimeRange>): { from: string; to: string; refresh: string };
  resolve(): { start: Date; end: Date } | null;
  query(): string;
  refresh(): void;
  open(): Promise<void>;
  close(): Promise<void>;
  on(type: 'change', fn: (detail: TimerangeChange) => void): () => void;
  on(type: 'refresh', fn: (detail: TimerangeRefresh) => void): () => void;
  destroy(): void;
}

/** The instant a value stands for, or null. */
export declare function parse(value: string, options?: { now?: Date | number; roundUp?: boolean; timeZone?: string; firstDay?: number }): Date | null;
/** The instants of a range at now. */
export declare function resolve(range: TimeRange, options?: { now?: Date | number; timeZone?: string; firstDay?: number }): { start: Date; end: Date } | null;
/** The milliseconds of a span, 0 for none. */
export declare function spanMs(span: string): number;
/** A range for people. */
export declare function label(range: TimeRange, options?: { locale?: string; now?: Date | number; timeZone?: string }): string;
/** A range and its refresh as a query string. */
export declare function query(range: TimeRange): string;
/** The time range's controller, the one [data-ds-timerange] makes. */
export declare function create(root: Element, options?: TimerangeOptions): TimerangeController;
