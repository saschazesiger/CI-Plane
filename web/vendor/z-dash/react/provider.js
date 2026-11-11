/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <DSProvider> (dist/react/provider.js): the root of a React tree on
 * Z-Dash. It renders the .ds-theme element (or wraps a tree in
 * one that exists already) and calls DS.init() on it with the observer
 * on, so the delegated behaviours (the ripple, the action guard, tooltips
 * for every [data-tip], the [data-ds-open] and [data-ds-close] triggers)
 * serve everything inside, and plain data-ds-* markup React renders
 * outside an adapter component is initialised as on any page.
 *
 *   createRoot(el).render(
 *     createElement(StrictMode, null,
 *       createElement(DSProvider, { scheme: 'dark', strings: { close: 'Schliessen' } }, createElement(App))));
 *
 * Props: as (default 'div'), theme (default true: the element carries
 * .ds-theme; false when the page's <html> or a host element is the theme),
 * base (the opt-in page base, .ds-base), scheme ('light' | 'dark':
 * data-ds-scheme of a theme for both schemes, a preset or a generated
 * one; none follows the system), size, density, shape and touch
 * (option classes on the whole tree), root ('document': DS.init(document)
 * instead of the element, for a single-page app that owns the page),
 * observe (default true), locale and strings (DS.config(), page-wide),
 * and every other prop of the element.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef, useRef } from 'react';
import { init, config } from '../js/core.js';
import '../js/motion.js';
import '../js/ripple.js';
import '../js/overlay.js';
import '../js/tooltip.js';
import { cx, optionClasses, useIsomorphicLayoutEffect, useMergedRef } from './shared.js';

export const DSProvider = forwardRef(function DSProvider(props, ref) {
  const { as = 'div', theme = true, base = false, scheme, size, density, shape, touch, root, observe = true, locale, strings, className, children, ...rest } = props;
  const elementRef = useRef(null);
  const merged = useMergedRef(ref, elementRef);
  useIsomorphicLayoutEffect(() => {
    const target = root === 'document' ? elementRef.current?.ownerDocument : elementRef.current;
    if (!target) return undefined;
    const handle = init(target, { observe });
    return () => handle.destroy();
  }, [root, observe]);
  // The strings and the locale are the page's (one runtime per page). They are set while rendering, before the
  // children render (they read t() then), once per change; config() is idempotent and dispatches ds:config.
  const configured = useRef(null);
  const key = locale === undefined && !strings ? '' : JSON.stringify([locale ?? null, Object.entries(strings ?? {}).map(([name, value]) => [name, typeof value === 'function' ? String(value) : value])]);
  if (key && configured.current !== key) {
    configured.current = key;
    config({ ...(locale === undefined ? {} : { locale }), ...(strings ? { strings } : {}) });
  }
  return createElement(as, {
    ...rest,
    ref: merged,
    className: cx(theme && 'ds-theme', base && 'ds-base', optionClasses({ size, density, shape, touch }), className) || undefined,
    ...(scheme === 'light' || scheme === 'dark' ? { 'data-ds-scheme': scheme } : {}),
  }, children);
});
