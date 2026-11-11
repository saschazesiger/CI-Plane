/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.chart (src/components/chart/chart.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export type ChartType = 'line' | 'area' | 'column' | 'bar' | 'combo' | 'sparkline' | 'donut' | 'pie' | 'ring' | 'gauge' | 'bargauge';
export type ChartTone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error';
/** 'bytes', 'percent' (a share: 0.42 is 42%), or Intl.NumberFormat options. */
export type ChartFormat = 'bytes' | 'percent' | Intl.NumberFormatOptions;

export interface ChartSeries {
  name: string;
  /** One value per label; null (or a blank, a dash) is a gap. */
  values: Array<number | string | null>;
  /** The mark of this series (default from the type; combo: columns, the last series a line). */
  mark?: 'line' | 'area' | 'column';
  /** The value axis: 'end' is the second axis of a combo. */
  axis?: 'start' | 'end';
  /** A tone instead of the series colour (single-series meaning, always with its name). */
  tone?: ChartTone;
  /** false hides it at first (its legend key stays). */
  visible?: boolean;
}

export interface ChartAxis {
  type?: 'linear' | 'log';
  min?: number;
  max?: number;
  label?: string;
  /** false lets a line chart's axis leave out zero. */
  zero?: boolean;
  format?: ChartFormat;
}

export interface ChartThreshold {
  /** A line at a value ... */
  value?: number;
  /** ... or a band from a value to another. */
  from?: number;
  to?: number;
  label?: string;
  axis?: 'start' | 'end';
  tone?: ChartTone;
}

export interface ChartAnnotation {
  /** A line at an x (a label, a date, a number) ... */
  at?: string | number | Date;
  /** ... or a band along x. */
  from?: string | number | Date;
  to?: string | number | Date;
  label?: string;
  tone?: ChartTone;
}

export interface ChartZone {
  /** The upper end of the zone (the last one: the max). */
  to?: number;
  tone?: ChartTone;
  /** The word that says it ("High"); shown with the value. */
  label?: string;
}

export interface ChartSpec {
  type?: ChartType;
  /** The x of each point: dates (ISO text or Date), numbers or categories. */
  labels?: Array<string | number | Date>;
  series?: ChartSeries[];
  /** A gauge's (or ring's) one value, instead of series. */
  value?: number;
  name?: string;
  /** 'normal' (or true) stacks; 'percent' stacks to 100%. */
  stack?: boolean | 'normal' | 'percent';
  curve?: 'linear' | 'monotone' | 'step';
  /** Markers on the points: 'auto' (where there is room), true, false. */
  markers?: boolean | 'auto';
  /** Series 2 to 4 of fills hatched, as in forced colours. */
  patterns?: boolean;
  /** A sparkline's mark. */
  mark?: 'line' | 'area' | 'bar';
  x?: { type?: 'time' | 'linear' | 'band'; label?: string; format?: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions };
  y?: ChartAxis;
  /** The second value axis of a combo (the line's). */
  y2?: ChartAxis;
  format?: ChartFormat;
  thresholds?: ChartThreshold[];
  annotations?: ChartAnnotation[];
  /** Gauge, ring and bar gauge: the scale. */
  min?: number;
  max?: number;
  /** Gauge and bar gauge: the zones, in order. */
  zones?: ChartZone[];
  /** Show the legend (default: two or more series, or slices). */
  legend?: boolean;
  /** Offer the table view (default true, except gauges and sparklines). */
  table?: boolean;
  /** Show the tooltip (a sparkline: only when true). */
  tooltip?: boolean;
  /** The words under a donut's, ring's or gauge's figure. */
  label?: string;
  /** The chart's name, when the figure has no caption. */
  title?: string;
}

export interface ChartPoint {
  index: number;
  series: number;
  key: string;
  label: string;
}

export interface ChartController {
  /** The spec as given, with each series' visibility. */
  get(): ChartSpec;
  /** New data or options, merged over the current spec: lines morph, bars glide, figures count. */
  set(next: ChartSpec): void;
  on(type: 'change', fn: (detail: { spec: ChartSpec }) => void): () => void;
  on(type: 'toggle', fn: (detail: { series: number; name: string; visible: boolean }) => void): () => void;
  on(type: 'view', fn: (detail: { view: 'chart' | 'table' }) => void): () => void;
  on(type: 'point' | 'select', fn: (detail: ChartPoint) => void): () => void;
  /** Shows or hides a series (by index or name), on a donut or pie a slice (by index or label); never hides the last one. */
  toggle(series: number | string, visible?: boolean): boolean;
  /** 'chart' or 'table'; returns the view in force. */
  view(mode?: 'chart' | 'table'): 'chart' | 'table';
  /** Moves the cursor to a point (and a series), announced. */
  focus(index: number, series?: number): void;
  /** Reads the attributes and the table again. */
  update(): void;
  destroy(): void;
}

export interface ChartScale {
  type: 'linear' | 'log' | 'time' | 'band';
  domain: any[];
  range: [number, number];
  bandwidth: number;
  step: number;
  map(value: any): number;
  invert(px: number): number;
  ticks(count?: number): any[];
}

export interface ChartMetrics {
  measure?: (text: string) => number;
  line?: number;
  gap?: number;
  bar?: number;
  seam?: number;
  marker?: number;
}

/** About `count` round values from `min` to `max`. */
export declare function ticks(min: number, max: number, count?: number): number[];
/** About `count` ticks of a time axis (ms) on whole units of local time. */
export declare function timeTicks(min: number, max: number, count?: number): number[];
/** A scale from a domain to a range of pixels. */
export declare function scale(type: 'linear' | 'log' | 'time' | 'band', domain: any[], range: [number, number], options?: { padding?: number; outer?: number }): ChartScale;
/** The SVG path data of a line or an area through points (null: a gap). */
export declare function path(points: Array<{ x: number; y: number | null; y0?: number | null } | null>, options?: { curve?: 'linear' | 'monotone' | 'step'; area?: boolean }): string;
/** Stacks series: per series and index [lo, hi], or null for a gap. */
export declare function stack(series: Array<Array<number | null | undefined>>, options?: { offset?: 'normal' | 'percent' }): Array<Array<[number, number] | null>>;
/** The index of the position nearest to `value` in a sorted list, or -1. */
export declare function nearest(positions: number[], value: number): number;
/** A <table> as a chart spec. */
export declare function parse(table: HTMLTableElement): { labels: any[]; series: ChartSeries[]; x: { label: string } };
/** Where everything of a chart goes in a box (pure; no DOM). */
export declare function layout(spec: ChartSpec, width: number, height: number, metrics?: ChartMetrics): any;
/** Draws a chart into `el`: the controller the attribute path makes. */
export declare function create(el: Element, spec?: ChartSpec): ChartController;
