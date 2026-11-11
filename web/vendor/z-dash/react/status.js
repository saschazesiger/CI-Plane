/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Status> (dist/react/status.js): the status chip of docs/components.md,
 * "Status chip": the state of one item, always with an icon and a word.
 *
 *   createElement(Status, { tone: 'success' }, 'Synced')
 *   createElement(Status, { tone: 'warning', icon: clock }, 'Expires soon')
 *   createElement(Status, { running: true }, 'Running')
 *
 * Props: tone ('neutral' default, 'primary', 'info', 'success', 'warning',
 * 'error'), icon (a glyph of js/icons.js or a node; default by tone: check,
 * alert, info, or clock for neutral), running (.ds-status--running: the
 * spinner instead of the icon), size, shape, and every prop of the <span>.
 * The children are the word; a status that changes while someone waits
 * goes through a live region (role="status" around it).
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef } from 'react';
import { alert, check, clock, info } from '../js/icons.js';
import { cx, iconNode, optionClasses, splitOptions } from './shared.js';

const ICONS = { success: check, warning: alert, error: alert, info, primary: info, neutral: clock };

export const Status = forwardRef(function Status(props, ref) {
  const [options, rest] = splitOptions(props);
  const { icon, running, className, children, ...attributes } = rest;
  const mark = running
    ? createElement('span', { className: 'ds-spinner ds-status__spinner', 'aria-hidden': 'true' })
    : iconNode(icon === undefined ? ICONS[options.tone] ?? clock : icon, 16);
  return createElement('span', { ...attributes, ref, className: cx('ds-status', running && 'ds-status--running', optionClasses(options), className) },
    mark, createElement('span', null, children));
});
Status.displayName = 'Status';
