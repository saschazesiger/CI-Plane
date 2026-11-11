/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Badge> (dist/react/badge.js): the .ds-badge of docs/components.md,
 * "Badge": a count or a dot on a button, chip, tab or drawer item.
 *
 *   createElement(Badge, { count: 3 })                            // DS.badge: 3, 99+ past max, nothing at 0
 *   createElement(Badge, { count: unread, max: 9, tone: 'error', corner: true, 'aria-hidden': 'true' })
 *   createElement(Badge, { dot: true, tone: 'primary', label: 'New tasks' })
 *   createElement(Badge, { tone: 'neutral' }, '12')                // a figure of your own
 *
 * Props: count (the figure through the behaviour of DS.badge, which pops
 * it in and out and writes max+ past max; the badge then has no children
 * of its own), max (default 99), dot (.ds-badge--dot; give it a label, its
 * word for screen readers, in .ds-sr), corner (.ds-badge--corner on an
 * icon button), tone, size, shape, and every prop of the <span>. Colour is
 * never the only signal: the host's name or the row says what it counts.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef } from 'react';
import '../js/badge.js';
import { cx, optionClasses, splitHandlers, splitOptions, useBehaviour, useMergedRef } from './shared.js';

export const Badge = forwardRef(function Badge(props, ref) {
  const [options, withoutOptions] = splitOptions(props);
  const [handlers, rest] = splitHandlers(withoutOptions);
  const { count, max, dot, corner, label, className, controllerRef, children, ...attributes } = rest;
  const counted = count !== undefined && count !== null;
  const elementRef = useBehaviour('badge', { controllerRef, handlers });
  const merged = useMergedRef(ref, elementRef);
  return createElement('span', {
    ...attributes,
    ...(counted ? { 'data-ds-badge': String(count), ...(max === undefined ? {} : { 'data-ds-badge-max': String(max) }) } : {}),
    'data-ds-managed': '',
    ref: merged,
    className: cx('ds-badge', dot && 'ds-badge--dot', corner && 'ds-badge--corner', optionClasses(options), className),
  }, counted ? null : label ? createElement('span', { className: 'ds-sr' }, label) : children);
});
Badge.displayName = 'Badge';
