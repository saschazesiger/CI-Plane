/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Button> (dist/react/button.js): the .ds-btn of docs/components.md,
 * "Button", as a React component.
 *
 *   createElement(Button, { variant: 'filled', type: 'submit' }, 'Save')
 *   createElement(Button, { variant: 'quiet', icon: pencil, 'aria-label': 'Edit' })   // icon button, tip = label
 *   createElement(Button, { variant: 'filled', faces: { busy: 'Saving', done: 'Saved', failed: 'Not saved' },
 *     action: () => save(form) }, 'Save')                                              // DS.motion.busy()
 *
 * Props: variant ('outlined' default, 'filled', 'tonal', 'elevated',
 * 'text', 'quiet', 'ghost', or a list with 'disc', 'disclosure',
 * 'adaptive'), block, icon (a glyph of js/icons.js or a node; without
 * children the button is an icon button, .ds-btn--icon, named by
 * aria-label, which is also its data-tip), size, density, shape, touch,
 * tone ('error' on a filled button only, for a destructive confirmation:
 * D10), faces (the busy, done and failed labels), action (runs through
 * DS.motion.busy() on click; a rejection shows the failed face and goes to
 * onActionError), as ('button' default, 'a' for a link), and every prop
 * of the element. The ripple and the action guard come from <DSProvider>.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef, useRef } from 'react';
import { busy } from '../js/motion.js';
import { alertCircle, check } from '../js/icons.js';
import { cx, iconNode, keepClasses, modifiers, optionClasses, splitOptions, textSafe, useMergedRef } from './shared.js';

export const Button = forwardRef(function Button(props, ref) {
  const [options, rest] = splitOptions(props);
  const { as = 'button', variant, block, icon, faces, action, onActionError, onClick, type, className, children, ...attributes } = rest;
  const elementRef = useRef(null);
  const merged = useMergedRef(ref, elementRef);
  const hasLabel = children !== undefined && children !== null && children !== false && children !== '';
  const iconOnly = !hasLabel && Boolean(icon);
  const element = elementRef.current;
  // The done and failed faces of busy() stay through a re-render: keepClasses() keeps them.
  const classes = cx('ds-btn', modifiers('ds-btn', variant), block && 'ds-btn--block', iconOnly && 'ds-btn--icon', optionClasses(options), className);
  const glyph = iconNode(icon, iconOnly ? 20 : 16);
  // Children as arguments of their own: no key warnings, and a lone text stays its own node (textSafe).
  const parts = faces
    ? [createElement('span', { className: 'ds-btn__faces' },
      createElement('span', { className: 'ds-btn__face' }, glyph, children),
      faces.busy !== undefined && createElement('span', { className: 'ds-btn__face ds-btn__face--busy', 'aria-hidden': 'true' },
        createElement('span', { className: 'ds-spinner ds-spinner--ink ds-sm' }), faces.busy),
      faces.done !== undefined && createElement('span', { className: 'ds-btn__face ds-btn__face--done', 'aria-hidden': 'true' },
        iconNode(check, 16), faces.done),
      faces.failed !== undefined && createElement('span', { className: 'ds-btn__face ds-btn__face--failed', 'aria-hidden': 'true' },
        iconNode(alertCircle, 16), faces.failed))]
    : glyph ? [glyph, hasLabel ? children : null] : [textSafe(children)];
  const label = attributes['aria-label'];
  const handleClick = (event) => {
    onClick?.(event);
    if (!action || event.defaultPrevented) return;
    busy(event.currentTarget, () => action(event)).catch((error) => onActionError?.(error));
  };
  return createElement(as, {
    ...(as === 'button' ? { type: type ?? 'button' } : type === undefined ? {} : { type }),
    ...(iconOnly && label && attributes['data-tip'] === undefined ? { 'data-tip': label } : {}),
    ...attributes,
    ref: merged,
    className: keepClasses(element, classes),
    onClick: action || onClick ? handleClick : undefined,
  }, ...parts);
});
Button.displayName = 'Button';
