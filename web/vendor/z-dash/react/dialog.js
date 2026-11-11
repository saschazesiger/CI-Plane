/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Dialog> (dist/react/dialog.js): the native <dialog class="ds-dialog">
 * of docs/components.md, "Dialog", opened and closed by DS.overlay: focus
 * moves in and back to the opener, the page is inert, Escape, the backdrop
 * and [data-ds-close] close it, the scroll lock counts, and the motion is
 * the system's.
 *
 *   createElement(Dialog, {
 *     open, onClose: () => setOpen(false),
 *     title: 'Delete 3 devices?', description: 'They disappear from every list.', role: 'alertdialog',
 *     actions: [
 *       createElement(Button, { key: 'c', variant: 'text', 'data-ds-close': '', autoFocus: true }, 'Cancel'),
 *       createElement(Button, { key: 'd', variant: 'filled', tone: 'error', onClick: remove }, 'Delete 3 devices'),
 *     ],
 *   })
 *
 * Props: open, onClose(reason, event) (the user closed it: 'escape',
 * 'backdrop', 'close' for [data-ds-close], 'submit'; set open to false),
 * title (.ds-dialog__title, the dialog's name), description
 * (.ds-dialog__text, its description), actions (.ds-dialog__actions),
 * children (.ds-dialog__body, which scrolls), size ('sm', 'lg', 'xl'),
 * full (.ds-dialog--full; 'narrow' for --full-narrow), bottom (an action
 * sheet), role ('alertdialog' for a destructive confirmation), busy
 * (data-ds-busy: the user's closes do nothing while work runs), onSubmit
 * (the box is a <form data-ds-dialog-form>: Enter submits, the browser
 * validates, onSubmit(data, form) runs through DS.dialog.form(), busy on
 * the submit button, and a rejection keeps it open with errorText in a
 * snackbar), opener (the element focus goes back to; default the focused
 * one), density, shape, touch, and every prop of the <dialog>.
 *
 * The body is plain content for DS.init(): data-ds-* markup in it is
 * initialised as anywhere (the dialog is no managed root). Render a dialog
 * that opens over another dialog inside that dialog's content: DS.overlay
 * would move one placed elsewhere into it while it shows.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef, useId, useRef } from 'react';
import { form } from '../js/dialog.js';
import { cx, keepClasses, optionClasses, splitOptions, useIsomorphicLayoutEffect, useMergedRef, useOverlay } from './shared.js';

export const Dialog = forwardRef(function Dialog(props, ref) {
  const [options, rest] = splitOptions(props);
  const { open = false, onClose, title, description, actions, size, full, bottom, busy, onSubmit, errorText, opener, className, children, ...attributes } = rest;
  const base = useId();
  const elementRef = useRef(null);
  const merged = useMergedRef(ref, elementRef);
  useOverlay(elementRef, Boolean(open), { onClose, opener });
  const latest = useRef(onSubmit);
  latest.current = onSubmit;
  const isForm = typeof onSubmit === 'function';
  useIsomorphicLayoutEffect(() => {
    if (!isForm || !elementRef.current) return;
    form(elementRef.current, { onSubmit: (data, box) => latest.current?.(data, box), errorText });
  }, [isForm, errorText]);
  const titleId = title ? `${base}title` : undefined;
  const textId = description ? `${base}text` : undefined;
  const box = createElement(isForm ? 'form' : 'div', { className: 'ds-dialog__box', ...(isForm ? { 'data-ds-dialog-form': '' } : {}) },
    title ? createElement('h2', { className: 'ds-dialog__title', id: titleId }, title) : null,
    description ? createElement('p', { className: 'ds-dialog__text', id: textId }, description) : null,
    children === undefined || children === null ? null : createElement('div', { className: 'ds-dialog__body' }, children),
    actions ? createElement('div', { className: 'ds-dialog__actions' }, actions) : null);
  const classes = cx('ds-dialog', size && `ds-dialog--${size}`, full === 'narrow' ? 'ds-dialog--full-narrow' : full && 'ds-dialog--full', bottom && 'ds-dialog--bottom',
    optionClasses({ ...options, size: undefined, tone: undefined }), className);
  return createElement('dialog', {
    'aria-labelledby': titleId,
    'aria-describedby': textId,
    ...attributes,
    ...(busy ? { 'data-ds-busy': '' } : {}),
    ref: merged,
    className: keepClasses(elementRef.current, classes),
  }, createElement('div', { className: 'ds-dialog__backdrop', 'data-ds-close': '' }), box);
});
Dialog.displayName = 'Dialog';
