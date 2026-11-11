/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Alert> (dist/react/alert.js): the .ds-alert of docs/components.md,
 * "Alert": a message about a page or a section, in place, with an icon and
 * a word.
 *
 *   createElement(Alert, null, 'Sync runs at night.')
 *   createElement(Alert, { tone: 'warning', title: 'Certificate expires soon',
 *     actions: createElement(Button, { variant: 'text', size: 'sm' }, 'Renew') }, 'Renew it before 1 May.')
 *   createElement(Alert, { tone: 'error', variant: 'section', title: 'The import stopped' }, 'Nothing was saved.')
 *   createElement(Alert, { tone: 'warning', variant: 'inline' }, 'Used by 3 other devices.')
 *
 * Props: tone (none: the neutral information alert; 'success', 'warning',
 * 'error', 'info', 'primary', 'neutral'), variant ('plain', 'inline',
 * 'section'), icon (default by tone: info, checkCircle, alert,
 * alertCircle; false for none), title (.ds-alert__title), actions
 * (.ds-alert__actions), role (default 'alert' for an error, else none:
 * give 'status' to a message that appears while someone waits), size,
 * density, shape, and every prop of the element (a <p> when inline, else
 * a <div>).
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef } from 'react';
import { alert, alertCircle, checkCircle, info } from '../js/icons.js';
import { cx, iconNode, modifiers, optionClasses, splitOptions } from './shared.js';

const ICONS = { success: checkCircle, warning: alert, error: alertCircle };

export const Alert = forwardRef(function Alert(props, ref) {
  const [options, rest] = splitOptions(props);
  const { variant, icon, title, actions, role, className, children, ...attributes } = rest;
  const inline = variant === 'inline' || (Array.isArray(variant) && variant.includes('inline'));
  const glyph = icon === false ? null : iconNode(icon === undefined ? ICONS[options.tone] ?? info : icon, inline ? 16 : 20);
  const text = title !== undefined && title !== null
    ? createElement('div', { className: 'ds-alert__text' },
      createElement('p', { className: 'ds-alert__title' }, title),
      typeof children === 'string' ? createElement('p', null, children) : children)
    : createElement('span', { className: 'ds-alert__text' }, children);
  const resolvedRole = role ?? (options.tone === 'error' ? 'alert' : undefined);
  return createElement(inline ? 'p' : 'div', {
    ...attributes,
    ...(resolvedRole ? { role: resolvedRole } : {}),
    ref,
    className: cx('ds-alert', modifiers('ds-alert', variant), optionClasses(options), className),
  }, glyph, text, actions ? createElement('div', { className: 'ds-alert__actions' }, actions) : null);
});
Alert.displayName = 'Alert';
