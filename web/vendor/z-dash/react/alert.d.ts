/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Alert> (react/alert.js). */
import type * as React from 'react';
import type { Density, Shape, Size, Tone } from './shared.js';

export type AlertVariant = 'plain' | 'inline' | 'section';

export type AlertProps = Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'title'> & {
  /** None: the neutral information alert. */
  tone?: Tone;
  variant?: AlertVariant | AlertVariant[];
  /** A glyph of js/icons.js or a node (default by tone); false for none. */
  icon?: string | React.ReactNode | false;
  /** .ds-alert__title. */
  title?: React.ReactNode;
  /** .ds-alert__actions. */
  actions?: React.ReactNode;
  /** Default 'alert' for an error, else none. */
  role?: string;
  size?: Size;
  density?: Density;
  shape?: Shape;
  className?: string;
  children?: React.ReactNode;
};

export declare const Alert: React.ForwardRefExoticComponent<AlertProps & React.RefAttributes<HTMLElement>>;
