/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <DSProvider> (react/provider.js). */
import type * as React from 'react';
import type { Density, IntrinsicTag, Shape, Size } from './shared.js';
import type { Text } from '../js/core.js';

export type DSProviderProps = Omit<React.HTMLAttributes<HTMLElement>, 'className'> & {
  /** The element (default 'div'). */
  as?: IntrinsicTag;
  /** Carry .ds-theme (default true); false when <html> or a host element is the theme. */
  theme?: boolean;
  /** The opt-in page base, .ds-base. */
  base?: boolean;
  /** Pin the scheme (data-ds-scheme) of a theme for both schemes (a preset or a generated theme); none follows the system. */
  scheme?: 'light' | 'dark';
  size?: Size;
  density?: Density;
  shape?: Shape;
  touch?: boolean;
  /** 'document': DS.init(document) instead of the element (an app that owns the page). */
  root?: 'document';
  /** Keep initialising plain data-ds-* markup React adds later (default true). */
  observe?: boolean;
  /** DS.config({ locale }): the page's locale. */
  locale?: string | null;
  /** DS.config({ strings }): the system's texts by key. */
  strings?: Record<string, Text | null>;
  className?: string;
  children?: React.ReactNode;
};

export declare const DSProvider: React.ForwardRefExoticComponent<DSProviderProps & React.RefAttributes<HTMLElement>>;
