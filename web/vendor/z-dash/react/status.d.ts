/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Status> (react/status.js). */
import type * as React from 'react';
import type { Shape, Size, Tone } from './shared.js';

export type StatusProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'> & {
  tone?: Tone;
  /** A glyph of js/icons.js or a node (default by tone). */
  icon?: string | React.ReactNode;
  /** .ds-status--running: a spinner instead of the icon. */
  running?: boolean;
  size?: Size;
  shape?: Shape;
  className?: string;
  /** The word: the status itself. */
  children?: React.ReactNode;
};

export declare const Status: React.ForwardRefExoticComponent<StatusProps & React.RefAttributes<HTMLSpanElement>>;
