/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Formatted> (react/formatted.js), generated from src/components/formatted/. */
import type { BehaviourComponent } from './shared.js';

export type FormattedVariant = never;

export interface FormattedEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes, and its content. */
export interface FormattedOptions {
  /** data-ds-format-currency (true: present, false or none: absent). */
  currency?: string | number | boolean | object | null;
  /** data-ds-format-digits (true: present, false or none: absent). */
  digits?: string | number | boolean | object | null;
  /** data-ds-format-base (true: present, false or none: absent). */
  base?: string | number | boolean | object | null;
  /** data-ds-format-style (true: present, false or none: absent). */
  dsFormatStyle?: string | number | boolean | object | null;
  /** data-ds-format-signed (true: present, false or none: absent). */
  signed?: string | number | boolean | object | null;
  /** data-ds-format-tip (true: present, false or none: absent). */
  tip?: string | number | boolean | object | null;
  /** The value the behaviour formats (data-ds-value); string children give it too. */
  value?: string | number | null;
  children?: string | number;
}

export declare const Formatted: BehaviourComponent<'span', FormattedVariant, FormattedEvents & FormattedOptions, ReturnType<typeof import('../js/formatted.js').create>>;
