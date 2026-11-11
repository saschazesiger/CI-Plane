/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Chart> (react/chart.js), generated from src/components/chart/. */
import type { BehaviourComponent } from './shared.js';

export type ChartVariant = 'bar' | 'bargauge' | 'donut' | 'empty' | 'gauge' | 'patterns' | 'pie' | 'ring' | 'sparkline' | 'stacked';

export interface ChartEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:point on the root. */
  onDsPoint?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
  /** ds:toggle on the root. */
  onDsToggle?: (event: CustomEvent) => void;
  /** ds:view on the root. */
  onDsView?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ChartOptions {
  /** data-ds-config (true: present, false or none: absent). */
  dsConfig?: string | number | boolean | object | null;
}

export declare const Chart: BehaviourComponent<'figure', ChartVariant, ChartEvents & ChartOptions, ReturnType<typeof import('../js/chart.js').create>>;
