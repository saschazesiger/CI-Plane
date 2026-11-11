/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The React adapter's shared part (dist/react/shared.js): option classes,
 * refs, the life of a behaviour on an element React renders, overlays,
 * icons, and behaviour(), which makes every adapter component of a
 * behaviour module (the generated files of dist/react/).
 *
 *   import { useBehaviour, cx, optionClasses } from '<dest>/react/shared.js';
 *   const ref = useBehaviour('copy', { controllerRef, handlers });
 *
 * How the adapter and the system share the DOM (docs/react.md):
 * - An adapter component renders the documented markup and marks its root
 *   data-ds-managed, which DS.init() and its observer skip. It runs the
 *   behaviour itself through manage() of js/core.js, in a layout effect, so
 *   the controller exists before the browser paints; the cleanup destroys
 *   it, and a second cleanup does nothing (StrictMode runs the effect,
 *   its cleanup and the effect again).
 * - What the system writes survives a re-render because React never
 *   writes it: data-state, inert, popover, hidden and aria-* that a
 *   controller owns are set by the adapter on the first render only (a
 *   prop React does not change is never written again), the ripple's
 *   spans are nodes React does not know, and a text child is rendered as
 *   its own text node (React would otherwise set textContent and drop
 *   the ripple). A className React writes keeps the system's state
 *   classes (SYSTEM_CLASSES, and what a behaviour claims with own()).
 * - A behaviour that writes its element's content itself (Markdown,
 *   Highlight, Formatted, Time, Truncate, SearchHits, Kbd: `content` of
 *   names.json) gets no React children: its text is a prop, written
 *   before the behaviour starts and handed to it on a change.
 * - Events: a prop onDs<Type> listens to ds:<type> on the root, for the
 *   events of this component only (not those of a managed component or a
 *   handed-back part inside it).
 *
 * ES2022, no JSX (createElement), no build step; react 18 or later is the
 * project's own (a peer). Progressive: none.
 */
import { createElement, forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { manage } from '../js/core.js';
import { open as openOverlay, close as closeOverlay } from '../js/overlay.js';

/** useLayoutEffect in a browser; useEffect where there is no DOM (server rendering warns about the other). */
export const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** The values of the option classes (src/core/options.css, docs/options.md). */
export const SIZES = Object.freeze(['xs', 'sm', 'md', 'lg', 'xl']);
export const DENSITIES = Object.freeze(['comfortable', 'compact', 'dense', 'tight']);
export const SHAPES = Object.freeze(['square', 'soft', 'default', 'round']);
export const TONES = Object.freeze(['neutral', 'primary', 'info', 'success', 'warning', 'error']);

/** The attribute that hands a root to its owner (js/core.js). */
export const MANAGED = 'data-ds-managed';

/**
 * One class string from strings, arrays and falsy values (left out), each
 * class once.
 * @param {...any} parts
 * @returns {string}
 */
export function cx(...parts) {
  const out = [];
  const add = (part) => {
    if (!part) return;
    if (Array.isArray(part)) part.forEach(add);
    else for (const name of String(part).split(/\s+/)) if (name && !out.includes(name)) out.push(name);
  };
  parts.forEach(add);
  return out.join(' ');
}

/**
 * The option classes of size, density, shape, tone and touch (an unknown
 * value adds nothing).
 * @param {{ size?: string, density?: string, shape?: string, tone?: string, touch?: boolean }} options
 * @returns {string[]}
 */
export function optionClasses({ size, density, shape, tone, touch } = {}) {
  const classes = [];
  if (SIZES.includes(size)) classes.push(`ds-${size}`);
  if (DENSITIES.includes(density)) classes.push(`ds-density-${density}`);
  if (SHAPES.includes(shape)) classes.push(`ds-shape-${shape}`);
  if (TONES.includes(tone)) classes.push(`ds-tone-${tone}`);
  if (touch) classes.push('ds-touch');
  return classes;
}

/**
 * The modifier classes of a block: variant 'filled' or ['quiet', 'icon']
 * on 'ds-btn' gives ds-btn--filled, or ds-btn--quiet ds-btn--icon.
 * @param {string|null} block
 * @param {string|string[]|undefined|null} variant
 * @returns {string[]}
 */
export function modifiers(block, variant) {
  if (!block || !variant) return [];
  return (Array.isArray(variant) ? variant : [variant]).filter(Boolean).map((name) => `${block}--${name}`);
}

/** The props that become option classes, out of `props`: [options, rest]. */
export function splitOptions(props) {
  const { size, density, shape, tone, touch, ...rest } = props;
  return [{ size, density, shape, tone, touch }, rest];
}

/** Sets a React ref (a function or an object) to `value`. */
export function setRef(ref, value) {
  if (typeof ref === 'function') ref(value);
  else if (ref && typeof ref === 'object') ref.current = value;
}

/**
 * One callback ref that sets every ref given (the forwarded one and the
 * adapter's own), stable while they are.
 * @param {...any} refs
 */
export function useMergedRef(...refs) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((node) => refs.forEach((ref) => setRef(ref, node)), refs);
}

/**
 * A text child as a text node of its own: React sets textContent for a
 * lone string child, which would remove the ripple's spans.
 * @param {any} children
 */
export function textSafe(children) {
  return typeof children === 'string' || typeof children === 'number' ? [children] : children;
}

/**
 * The state classes the system writes on a root, kept when React writes
 * className: the ripple's press, the end faces of DS.motion.busy() and
 * DS.copy, the panel states of DS.overlay (stateClasses() of
 * scripts/react.mjs; test/react.test.js keeps both in step). Any class a
 * behaviour claims through DS.dom's own() is kept too.
 */
export const SYSTEM_CLASSES = Object.freeze(['ds-pressed', 'ds-btn--done', 'ds-btn--failed', 'ds-dialog--closing', 'ds-dialog--hidden',
  'ds-dialog--nested', 'ds-sheet--closing', 'ds-sheet--hidden']);

/** The claims of DS.dom's own() on an element (js/dom.js). */
const OWNED = Symbol.for('ds.owned');

/**
 * `className` plus the system's state classes the element carries now, so
 * a re-render during a press, a done face or a closing panel keeps them.
 * @param {Element|null} element
 * @param {string} className
 * @returns {string|undefined}
 */
export function keepClasses(element, className) {
  const list = element?.classList;
  const given = className.split(' ');
  const owned = element?.[OWNED]?.classes;
  const names = owned?.size ? [...SYSTEM_CLASSES, ...owned.keys()] : SYSTEM_CLASSES;
  const kept = list ? names.filter((name) => list.contains(name) && !given.includes(name)) : [];
  const value = cx(className, kept);
  return value || undefined;
}

/**
 * An option prop as its attribute's value: true gives the attribute
 * empty, false, null and undefined leave it out, an object is JSON.
 * @param {any} value
 * @returns {string|undefined}
 */
export function optionValue(value) {
  if (value === true) return '';
  if (value === false || value === null || value === undefined) return undefined;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The text of a content prop or of string children (a list of strings and numbers joins); null for none. */
export function contentText(value) {
  if (value === null || value === undefined || value === false || value === true) return null;
  if (Array.isArray(value)) {
    const parts = value.map(contentText);
    return parts.every((part) => part === null) ? null : parts.map((part) => part ?? '').join('');
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof console !== 'undefined') console.warn('Z-Dash React: this component takes its content as text (a string prop or string children)');
  return null;
}

/** onDsBeforeClose → 'before-close'; null for any other prop. */
export function eventType(prop) {
  const match = /^onDs([A-Z][A-Za-z0-9]*)$/.exec(prop);
  return match ? match[1].replace(/[A-Z]/g, (char, index) => (index ? '-' : '') + char.toLowerCase()) : null;
}

/** 'before-close' → 'onDsBeforeClose'. */
export function eventProp(type) {
  return `onDs${String(type).split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
}

/** The onDs<Type> props out of `props`: [handlers by event type, rest]. */
export function splitHandlers(props) {
  const handlers = {};
  const rest = {};
  for (const [key, value] of Object.entries(props)) {
    const type = eventType(key);
    if (type) handlers[type] = value;
    else rest[key] = value;
  }
  return [handlers, rest];
}

/** Whether `event` belongs to the component of `root` (not to a managed component or a handed-back part inside it). */
function ownEvent(event, root) {
  const target = event.target;
  if (target === root) return true;
  return typeof target?.closest === 'function' && target.closest(`[${MANAGED}]`) === root;
}

/**
 * Listens to ds:<type> on the root for every handler in `handlers` (by
 * event type), calling the latest handler of that type; listeners change
 * only when the set of types does.
 * @param {{ current: Element|null }} elementRef
 * @param {Record<string, Function|undefined>} handlers
 */
export function useDsEvents(elementRef, handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const types = Object.keys(handlers).filter((type) => typeof handlers[type] === 'function').sort().join(' ');
  useIsomorphicLayoutEffect(() => {
    const root = elementRef.current;
    if (!root || !types) return undefined;
    const abort = new AbortController();
    for (const type of types.split(' ')) {
      root.addEventListener(`ds:${type}`, (event) => {
        if (ownEvent(event, root)) latest.current[type]?.(event);
      }, { signal: abort.signal });
    }
    return () => abort.abort();
  }, [elementRef, types]);
}

/**
 * Runs the behaviour `name` on the element of the returned ref (see the
 * header): manage() in a layout effect, update() after every render (React
 * may have changed an option attribute), destroy() on unmount. The
 * controller goes to `controllerRef`; `handlers` are onDs<Type> handlers
 * by event type. `content` ({ text, mode }) is the text of a behaviour
 * that writes its element's content itself (React renders no children
 * there): written before the behaviour starts, and a new text goes in
 * through the controller's set() (mode 'set') or by starting it again on
 * the new text (mode 'reinit').
 * @param {string} name
 * @param {{ controllerRef?: any, handlers?: Record<string, Function|undefined>, content?: { text: string|null, mode: string }|null }} [options]
 * @returns {{ current: Element|null }}
 */
export function useBehaviour(name, options = {}) {
  const elementRef = useRef(null);
  const handleRef = useRef(null);
  const controllerRef = useRef(options.controllerRef);
  controllerRef.current = options.controllerRef;
  const content = useRef(null);
  content.current = options.content ?? null;
  /** The text the running controller shows (content: 'set' or 'reinit'). */
  const shown = useRef(null);
  const published = useRef(null);
  const publish = useCallback(() => {
    const controller = handleRef.current?.controller ?? null;
    if (published.current === controller) return;
    published.current = controller;
    setRef(controllerRef.current, controller);
  }, []);
  /** Starts the behaviour on `element`, its content written first (the text it reads on init). */
  const start = useCallback((element) => {
    if (content.current) {
      shown.current = content.current.text ?? '';
      if (element.textContent !== shown.current) element.textContent = shown.current;
    }
    const handle = manage(element, name);
    if (!handle && typeof console !== 'undefined') console.warn(`Z-Dash React: no behaviour "${name}" (load its module, js/${name}.js)`);
    handleRef.current = handle;
    return handle;
  }, [name]);
  useIsomorphicLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    start(element);
    publish();
    return () => {
      // The handle that runs now: a new text ('reinit') may have replaced the first.
      handleRef.current?.destroy();
      handleRef.current = null;
      publish();
    };
  }, [start, publish]);
  // After every commit: an option attribute React changed reaches the controller, and so does new content.
  useIsomorphicLayoutEffect(() => {
    const element = elementRef.current;
    const given = content.current;
    if (element && given && handleRef.current && (given.text ?? '') !== shown.current) {
      const controller = handleRef.current.controller;
      if (given.mode === 'set' && typeof controller?.set === 'function') {
        shown.current = given.text ?? '';
        controller.set(shown.current);
      } else {
        handleRef.current.destroy();
        start(element);
      }
    }
    handleRef.current?.update();
    publish();
  });
  useDsEvents(elementRef, options.handlers ?? {});
  return elementRef;
}

/**
 * Opens and closes an overlay root (a dialog, a sheet) with `open`, through
 * the module's open() and close() (default: DS.overlay's), with the
 * element that had the focus as its opener. A close the user asked for
 * (Escape, the backdrop, [data-ds-close]) calls onClose(reason, event);
 * the parent then sets open to false. To refuse those closes while work
 * runs, set data-ds-busy on the root.
 * @param {{ current: Element|null }} elementRef
 * @param {boolean} open
 * @param {{ onClose?: Function, openWith?: Function, closeWith?: Function, opener?: any }} [options]
 */
export function useOverlay(elementRef, open, options = {}) {
  const latest = useRef(options);
  latest.current = options;
  const shown = useRef(false);
  useIsomorphicLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const onClose = (event) => {
      if (event.target !== element) return;
      const wasShown = shown.current;
      shown.current = false;
      if (wasShown) latest.current.onClose?.(event.detail?.reason ?? 'close', event);
    };
    element.addEventListener('ds:close', onClose);
    return () => element.removeEventListener('ds:close', onClose);
  }, [elementRef]);
  useIsomorphicLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const { openWith = openOverlay, closeWith = closeOverlay } = latest.current;
    if (open && !shown.current) {
      shown.current = true;
      const doc = element.ownerDocument;
      const given = latest.current.opener;
      const opener = (given && typeof given === 'object' && 'current' in given ? given.current : given) ?? doc.activeElement;
      openWith(element, { opener: opener && opener !== doc.body ? opener : undefined });
    } else if (!open && shown.current) {
      shown.current = false;
      closeWith(element);
    }
  }, [elementRef, open]);
  // Unmounted while open: DS.overlay closes a removed overlay at once (its observer); nothing to undo here.
}

/** The parsed shapes of each glyph (icons.js glyphs are flat elements with plain attributes). */
const shapes = new Map();
const SHAPE = /<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*?)\/?>/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

function shapesOf(glyph) {
  let list = shapes.get(glyph);
  if (!list) {
    list = [...String(glyph).matchAll(SHAPE)].map(([, tag, attributes], index) => {
      const props = { key: index };
      for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) props[name] = value;
      return [tag, props];
    });
    shapes.set(glyph, list);
  }
  return list;
}

/**
 * An icon of js/icons.js as an <svg> React renders (no innerHTML):
 * <Icon glyph={check} size={16} />. Decorative, aria-hidden.
 */
export function Icon({ glyph, size = 20, className }) {
  const children = useMemo(() => shapesOf(glyph).map(([tag, props]) => createElement(tag, props)), [glyph]);
  return createElement('svg', {
    className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
  }, children);
}

/** An icon prop: a glyph string of js/icons.js, or any React node (null: none). */
export function iconNode(icon, size, className) {
  if (icon === null || icon === undefined || icon === false) return null;
  return typeof icon === 'string' ? createElement(Icon, { glyph: icon, size, className }) : icon;
}

/**
 * The adapter component of one behaviour (the generated files of
 * dist/react/ call it): renders `spec.tag` (or `as`) with the base classes,
 * the modifiers of `variant`, the option classes, the behaviour's attribute
 * and data-ds-managed, and runs the behaviour (useBehaviour). `spec.options`
 * maps option props to their attributes; `spec.content` (names.json) takes
 * the content of a behaviour that writes it itself as a prop or string
 * children, and renders no children. With `spec.overlay`, `open` opens and
 * closes it (useOverlay) and onClose reports a close the user asked for.
 * @param {{ name: string, display: string, attribute: string, tag: string, classes?: string[], block?: string|null,
 *           role?: string|null, options?: Record<string, string>|null,
 *           content?: { mode: string, prop?: string, attribute?: string }|null,
 *           overlay?: { open?: Function, close?: Function }|null }} spec
 */
export function behaviour(spec) {
  const Component = forwardRef(function DsBehaviour(props, ref) {
    const [options, withoutOptions] = splitOptions(props);
    const [handlers, rest] = splitHandlers(withoutOptions);
    const { as, variant, className, controllerRef, children, open, onClose, opener, ...attributes } = rest;
    // Option props become their documented attributes (anchors → data-ds-markdown-anchors).
    const written = {};
    for (const [prop, attribute] of Object.entries(spec.options ?? {})) {
      if (!(prop in attributes)) continue;
      const value = optionValue(attributes[prop]);
      delete attributes[prop];
      if (value !== undefined) written[attribute] = value;
    }
    // Content the behaviour writes itself: a prop or string children, never React's own nodes.
    const content = spec.content ?? null;
    let text = null;
    if (content && content.mode !== 'none') {
      text = contentText(content.prop in attributes ? attributes[content.prop] : children);
      delete attributes[content.prop];
      if (content.mode === 'attribute' && text !== null) written[content.attribute] = text;
    }
    const pushed = content && (content.mode === 'set' || content.mode === 'reinit') ? { text, mode: content.mode } : null;
    const elementRef = useBehaviour(spec.name, { controllerRef, handlers, content: pushed });
    const merged = useMergedRef(ref, elementRef);
    if (spec.overlay) useOverlay(elementRef, Boolean(open), { onClose, opener, openWith: spec.overlay.open, closeWith: spec.overlay.close });
    const base = options.tone ? (spec.classes ?? []).filter((name) => !name.startsWith('ds-tone-')) : spec.classes;
    const classes = cx(base, modifiers(spec.block ?? null, variant), optionClasses(options), className);
    const element = {
      ...(spec.role ? { role: spec.role } : {}),
      ...attributes,
      ...written,
      ...(spec.overlay ? {} : open === undefined ? {} : { open }),
      ...(spec.overlay || onClose === undefined ? {} : { onClose }),
      [spec.attribute]: attributes[spec.attribute] ?? '',
      [MANAGED]: '',
      ref: merged,
      className: keepClasses(elementRef.current, classes),
    };
    return createElement(as ?? spec.tag, element, content ? undefined : textSafe(children));
  });
  Component.displayName = spec.display;
  return Component;
}
