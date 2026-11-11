/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Field> (react/field.js). */
import type * as React from 'react';
import type { Density, Shape, Size } from './shared.js';

type ControlAttributes = React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement> & React.SelectHTMLAttributes<HTMLSelectElement>;

export type FieldProps = Omit<ControlAttributes, 'size'> & {
  /** The visible label, above the control. */
  label: React.ReactNode;
  /** A hint under the control (aria-describedby). */
  hint?: React.ReactNode;
  /** The error message: aria-invalid, an icon and the words. */
  error?: React.ReactNode;
  /** A warning (.ds-field--warning). */
  warning?: React.ReactNode;
  /** A success (.ds-field--success). */
  success?: React.ReactNode;
  /** The look of the field. */
  variant?: 'outlined' | 'filled' | 'inset';
  /** .ds-field--full: a whole row of a form grid. */
  full?: boolean;
  /** The control (default 'input'). */
  as?: 'input' | 'textarea' | 'select';
  /** Classes of the .ds-field (className goes to the control). */
  fieldClassName?: string;
  size?: Size;
  density?: Density;
  shape?: Shape;
  touch?: boolean;
  /** A control of your own (one element: it gets id, aria-describedby, aria-invalid), or a select's options. */
  children?: React.ReactNode;
};

export declare const Field: React.ForwardRefExoticComponent<FieldProps & React.RefAttributes<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>>;
