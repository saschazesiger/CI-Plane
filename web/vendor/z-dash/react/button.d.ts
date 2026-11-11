/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Button> (react/button.js). */
import type * as React from 'react';
import type { IntrinsicTag, OptionProps } from './shared.js';

export type ButtonVariant = 'outlined' | 'filled' | 'tonal' | 'elevated' | 'text' | 'quiet' | 'ghost' | 'disc' | 'disclosure' | 'adaptive' | 'icon';

export interface ButtonFaces {
  /** The busy face's label (a spinner before it). */
  busy?: React.ReactNode;
  /** The success face's label (a check before it). */
  done?: React.ReactNode;
  /** The failed face's label (an alert before it). */
  failed?: React.ReactNode;
}

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement> & React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & OptionProps & {
  /** The look: one, or a list ('quiet' with 'disc'). Default: outlined. */
  variant?: ButtonVariant | ButtonVariant[];
  /** .ds-btn--block: fills its line. */
  block?: boolean;
  /** A glyph of js/icons.js or a node: before the label, or alone (an icon button: give it aria-label). */
  icon?: string | React.ReactNode;
  /** The busy, done and failed faces (DS.motion.busy). */
  faces?: ButtonFaces;
  /** Work to run on click through DS.motion.busy(). */
  action?: (event: React.MouseEvent<HTMLElement>) => unknown;
  /** The error of a rejected action (the failed face shows). */
  onActionError?: (error: unknown) => void;
  /** The element: 'button' (default) or 'a'. */
  as?: IntrinsicTag;
  className?: string;
  children?: React.ReactNode;
};

export declare const Button: React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLElement>>;
