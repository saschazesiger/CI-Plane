/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Dialog> (react/dialog.js). */
import type * as React from 'react';
import type { Density, OverlayProps, Shape } from './shared.js';

export type DialogProps = Omit<React.DialogHTMLAttributes<HTMLDialogElement>, 'className' | 'title' | 'open' | 'onClose' | 'onSubmit'> & OverlayProps & {
  /** .ds-dialog__title: the dialog's name. */
  title?: React.ReactNode;
  /** .ds-dialog__text: its description. */
  description?: React.ReactNode;
  /** .ds-dialog__actions. */
  actions?: React.ReactNode;
  /** The width of the box. */
  size?: 'sm' | 'lg' | 'xl';
  /** .ds-dialog--full; 'narrow': only at 600px and below. */
  full?: boolean | 'narrow';
  /** .ds-dialog--bottom: an action sheet. */
  bottom?: boolean;
  /** data-ds-busy: the user's closes do nothing while work runs. */
  busy?: boolean;
  /** A form dialog: Enter submits, the browser validates, this runs through DS.dialog.form() before it closes. */
  onSubmit?: (data: FormData, form: HTMLFormElement) => unknown;
  /** The snackbar of a rejected onSubmit. */
  errorText?: string;
  density?: Density;
  shape?: Shape;
  touch?: boolean;
  className?: string;
  /** .ds-dialog__body. */
  children?: React.ReactNode;
};

export declare const Dialog: React.ForwardRefExoticComponent<DialogProps & React.RefAttributes<HTMLDialogElement>>;
