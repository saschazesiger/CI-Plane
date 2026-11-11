/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Badge> (react/badge.js). */
import type * as React from 'react';
import type { DsEventProps, Shape, Size, Tone } from './shared.js';
import type { create } from '../js/badge.js';

export type BadgeProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'> & DsEventProps & {
  /** The count, through DS.badge: max+ past max, nothing at zero; the badge then has no children. */
  count?: number | string | null;
  /** The largest figure (default 99). */
  max?: number;
  /** .ds-badge--dot. */
  dot?: boolean;
  /** .ds-badge--corner: on an icon button's corner. */
  corner?: boolean;
  /** A dot's word for screen readers (.ds-sr). */
  label?: React.ReactNode;
  tone?: Tone;
  size?: Size;
  shape?: Shape;
  /** Receives DS.badge's controller while a count runs. */
  controllerRef?: React.Ref<ReturnType<typeof create> | null>;
  className?: string;
  children?: React.ReactNode;
};

export declare const Badge: React.ForwardRefExoticComponent<BadgeProps & React.RefAttributes<HTMLSpanElement>>;
