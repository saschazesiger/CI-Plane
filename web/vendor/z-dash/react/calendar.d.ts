/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Calendar> (react/calendar.js), generated from src/components/calendar/. */
import type { BehaviourComponent } from './shared.js';

export type CalendarVariant = never;

export interface CalendarEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:input on the root. */
  onDsInput?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface CalendarOptions {
  /** data-ds-value (true: present, false or none: absent). */
  dsValue?: string | number | boolean | object | null;
  /** data-ds-calendar-min (true: present, false or none: absent). */
  dsCalendarMin?: string | number | boolean | object | null;
  /** data-ds-calendar-max (true: present, false or none: absent). */
  dsCalendarMax?: string | number | boolean | object | null;
  /** data-ds-calendar-disabled (true: present, false or none: absent). */
  dsCalendarDisabled?: string | number | boolean | object | null;
  /** data-ds-calendar-months (true: present, false or none: absent). */
  months?: string | number | boolean | object | null;
  /** data-ds-calendar-mode (true: present, false or none: absent). */
  mode?: string | number | boolean | object | null;
  /** data-ds-calendar-weeks (true: present, false or none: absent). */
  weeks?: string | number | boolean | object | null;
  /** data-ds-calendar-first-day (true: present, false or none: absent). */
  firstDay?: string | number | boolean | object | null;
}

export declare const Calendar: BehaviourComponent<'div', CalendarVariant, CalendarEvents & CalendarOptions, ReturnType<typeof import('../js/calendar.js').create>>;
