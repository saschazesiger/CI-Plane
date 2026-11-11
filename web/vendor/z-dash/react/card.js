/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Card> (dist/react/card.js): the .ds-card of docs/components.md, "Card".
 *
 *   createElement(Card, { title: 'Sync', actions: createElement(Button, { size: 'sm' }, 'Run now') }, children)
 *   createElement(Card, { variant: 'filled' }, children)
 *   createElement(Card, { as: 'a', href: '/devices/42', interactive: true, title: 'Printer on floor 2' }, meta)
 *
 * Props: variant ('outlined' default, 'filled', 'elevated', 'horizontal',
 * or a list), interactive (.ds-card--interactive: state layer, press morph,
 * ripple; on an <a> or <button>), title (a .ds-card__title, an <h2> unless
 * titleAs says otherwise), actions (beside the title in a .ds-card__row),
 * as ('section' default), density, shape, touch, size (reaches the controls
 * inside), and every prop of the element. A card shows no tone.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef, useRef } from 'react';
import { cx, keepClasses, modifiers, optionClasses, splitOptions, useMergedRef } from './shared.js';

export const Card = forwardRef(function Card(props, ref) {
  const [options, rest] = splitOptions(props);
  const { as = 'section', variant, interactive, title, titleAs = 'h2', actions, className, children, ...attributes } = rest;
  const elementRef = useRef(null);
  const merged = useMergedRef(ref, elementRef);
  const heading = title === undefined || title === null ? null : createElement(titleAs, { className: 'ds-card__title' }, title);
  const head = heading && actions ? createElement('div', { className: 'ds-card__row' }, heading, actions) : heading;
  const classes = cx('ds-card', modifiers('ds-card', variant), interactive && 'ds-card--interactive', optionClasses({ ...options, tone: undefined }), className);
  return createElement(as, { ...attributes, ref: merged, className: keepClasses(elementRef.current, classes) }, head, children);
});
Card.displayName = 'Card';
