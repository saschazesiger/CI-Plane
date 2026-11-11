/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Card> (react/card.js). */
import type * as React from 'react';
import type { Density, IntrinsicTag, Shape, Size } from './shared.js';

export type CardVariant = 'outlined' | 'filled' | 'elevated' | 'horizontal' | 'selectable';

export type CardProps = Omit<React.HTMLAttributes<HTMLElement> & React.AnchorHTMLAttributes<HTMLAnchorElement> & React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'title'> & {
  /** The look: one, or a list. */
  variant?: CardVariant | CardVariant[];
  /** .ds-card--interactive: a whole card that opens or picks something (on an <a> or <button>). */
  interactive?: boolean;
  /** The .ds-card__title. */
  title?: React.ReactNode;
  /** The title's element (default 'h2'). */
  titleAs?: IntrinsicTag;
  /** Beside the title, in a .ds-card__row. */
  actions?: React.ReactNode;
  /** The element (default 'section'). */
  as?: IntrinsicTag;
  size?: Size;
  density?: Density;
  shape?: Shape;
  touch?: boolean;
  className?: string;
  children?: React.ReactNode;
};

export declare const Card: React.ForwardRefExoticComponent<CardProps & React.RefAttributes<HTMLElement>>;
