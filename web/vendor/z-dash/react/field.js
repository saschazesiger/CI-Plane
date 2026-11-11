/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Field> (dist/react/field.js): a labelled field of docs/components.md,
 * "Form": the label above the control, a hint and the states in words,
 * linked by ids.
 *
 *   createElement(Field, { label: 'Name', hint: 'As printed on the label.', name: 'name', required: true })
 *   createElement(Field, { label: 'Serial', error: 'Already in use.', defaultValue: 'SN-1' })
 *   createElement(Field, { label: 'Type', as: 'select' }, createElement('option', null, 'Laptop'))
 *   createElement(Field, { label: 'Notes', as: 'textarea', full: true })
 *   createElement(Field, { label: 'Code' }, createElement(MyInput, { className: 'ds-input' }))   // your own control
 *
 * Props: label (required: a field always has a visible label), hint,
 * error (the message: aria-invalid on the control, an icon and the words),
 * warning and success (the same for .ds-field--warning and --success),
 * variant ('outlined' default, 'filled', 'inset'), full (.ds-field--full in
 * a form grid), as ('input' default, 'textarea', 'select'), fieldClassName
 * (on the .ds-field), size, density, shape, touch (on the field), id (else
 * one of React's), and every prop of the control (value, onChange, name,
 * type, required ...). The ref is the control's. A single element child
 * replaces the control and gets its id, aria-describedby and aria-invalid
 * (select: its children are the options).
 *
 * ES2022, no JSX. Progressive: none.
 */
import { cloneElement, createElement, forwardRef, isValidElement, useId } from 'react';
import { alertCircle, alert as alertGlyph, checkCircle } from '../js/icons.js';
import { cx, iconNode, modifiers, optionClasses, splitOptions } from './shared.js';

export const Field = forwardRef(function Field(props, ref) {
  const [options, rest] = splitOptions(props);
  const { label, hint, error, warning, success, variant, full, as = 'input', fieldClassName, className, id, children, ...control } = rest;
  const auto = useId();
  const controlId = id ?? `${auto}control`;
  const hintId = hint ? `${auto}hint` : null;
  const stateId = error || warning || success ? `${auto}state` : null;
  const own = control['aria-describedby'];
  const describedBy = cx(own, hintId, stateId) || undefined;
  const state = error ? 'error' : warning ? 'warning' : success ? 'success' : null;
  const custom = as !== 'select' && isValidElement(children) ? children : null;
  const linked = { id: controlId, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': 'true' } : {}) };
  const field = custom
    ? cloneElement(custom, { ...linked, ref: custom.ref ?? ref })
    : createElement(as, { ...control, ...linked, ref, className: cx('ds-input', className) }, as === 'select' ? children : undefined);
  const glyph = { error: alertCircle, warning: alertGlyph, success: checkCircle }[state];
  return createElement('div', { className: cx('ds-field', modifiers('ds-field', variant), full && 'ds-field--full', state === 'warning' && 'ds-field--warning', state === 'success' && 'ds-field--success', optionClasses(options), fieldClassName) },
    createElement('label', { className: 'ds-field__label', htmlFor: controlId }, label),
    field,
    hint ? createElement('small', { className: 'ds-field__hint', id: hintId }, hint) : null,
    state ? createElement('small', { className: `ds-field__hint ds-field__hint--${state}`, id: stateId }, iconNode(glyph, 16), error || warning || success) : null);
});
Field.displayName = 'Field';
