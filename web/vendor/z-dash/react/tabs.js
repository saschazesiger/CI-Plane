/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Tabs> (dist/react/tabs.js): ARIA tabs of docs/components.md, "Tabs",
 * driven by DS.tabs: selection by click and the arrow keys (one tab stop),
 * the indicator, panels kept alive, closing, adding and the More menu.
 *
 *   createElement(Tabs, {
 *     label: 'Device',
 *     items: [
 *       { key: 'details', label: 'Details', panel: createElement(Details) },
 *       { key: 'history', label: 'History', count: 3, panel: createElement(History) },
 *     ],
 *     value, onChange: (key) => setValue(key),
 *   })
 *
 * Props: items ({ key, label, panel, count, icon, disabled, closable }),
 * label (the row's accessible name; or aria-labelledby), value (the
 * selected key: a change selects that tab) or defaultValue, onChange(key,
 * detail) (the user selected a tab; detail is the ds:change detail),
 * variant ('line' default, 'contained', 'fill', 'flush', 'vertical', or a
 * list; vertical puts the row beside its panels in .ds-tabs__columns),
 * overflow (tabs that do not fit go into a More menu), activate ('manual':
 * the arrow keys only move the focus, Enter or Space selects), onClose(key)
 * (a closable tab's close button, Delete, or its panel's close action:
 * remove the item; when it was selected its neighbour is selected already),
 * onAdd() and addLabel (an add button at the end of the bar: add an item),
 * lazy (default true: a panel renders its content the first time it is
 * selected, so hidden panels cost nothing up front), size, density, shape,
 * touch, panelClassName, className (on the row), and every other prop of
 * the row. onDs<Type> props listen to the row's ds:<type> events.
 *
 * Who writes what: React renders aria-selected, tabindex and the panels'
 * hidden once, from the first selection; DS.tabs keeps them from then on
 * (a later value goes through its set()), so a re-render never undoes a
 * selection. Tabs that DS.tabs folds into More carry hidden, which React
 * never writes.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { Fragment, createElement, forwardRef, useCallback, useId, useRef, useState } from 'react';
import { t } from '../js/core.js';
import { close as closeGlyph, plus } from '../js/icons.js';
import { announce } from '../js/a11y.js';
import '../js/tabs.js';
import { cx, iconNode, modifiers, optionClasses, splitHandlers, splitOptions, useBehaviour, useIsomorphicLayoutEffect, useMergedRef } from './shared.js';

const variants = (variant) => (Array.isArray(variant) ? variant : variant ? [variant] : []);

export const Tabs = forwardRef(function Tabs(props, ref) {
  const [options, withoutOptions] = splitOptions(props);
  const [handlers, rest] = splitHandlers(withoutOptions);
  const {
    items = [], label, value, defaultValue, onChange, variant, overflow, activate, onClose, onAdd, addLabel,
    lazy = true, panelClassName, className, controllerRef, ...attributes
  } = rest;
  const base = useId();
  const tabId = (key) => `${base}tab-${key}`;
  const panelId = (key) => `${base}panel-${key}`;
  const keyOfTab = (tab) => tab?.getAttribute('data-ds-key') ?? null;
  // The first selection: rendered once, then DS.tabs owns aria-selected, tabindex and hidden.
  const [initial] = useState(() => {
    const wanted = value ?? defaultValue;
    const found = items.find((item) => item.key === wanted && !item.disabled) ?? items.find((item) => !item.disabled);
    return found?.key ?? null;
  });
  const [shown, setShown] = useState(() => new Set(initial === null ? [] : [initial]));
  const controller = useRef(null);
  const latest = useRef({ onChange, onClose, onAdd, items });
  latest.current = { onChange, onClose, onAdd, items };
  const own = useCallback((made) => {
    controller.current = made;
    if (typeof controllerRef === 'function') controllerRef(made);
    else if (controllerRef) controllerRef.current = made;
  }, [controllerRef]);
  const elementRef = useBehaviour('tabs', {
    controllerRef: own,
    handlers: {
      ...handlers,
      change: (event) => {
        const key = keyOfTab(event.detail?.tab);
        if (key !== null) setShown((before) => (before.has(key) ? before : new Set(before).add(key)));
        if (key !== null) latest.current.onChange?.(key, event.detail);
        handlers.change?.(event);
      },
      close: (event) => {
        // React owns the tabs and panels: it removes them once the page drops the item.
        event.preventDefault();
        const tab = event.detail?.tab;
        const key = keyOfTab(tab);
        if (key === null) return;
        const tabs = [...(elementRef.current?.querySelectorAll('.ds-tabs__tab') ?? [])];
        const enabled = (each) => each !== tab && each.getAttribute('aria-disabled') !== 'true' && !each.disabled;
        if (tab.getAttribute('aria-selected') === 'true') {
          const at = tabs.indexOf(tab);
          const next = tabs.slice(at + 1).find(enabled) ?? tabs.slice(0, at).reverse().find(enabled);
          const doc = tab.ownerDocument;
          const focused = tab.parentElement?.contains(doc.activeElement) || event.detail?.panel?.contains(doc.activeElement);
          if (next) controller.current?.select(next, { focus: Boolean(focused) });
        }
        latest.current.onClose?.(key, event.detail);
        announce(t('tabClosed', { label: tab.getAttribute('data-label') ?? tab.textContent.trim() }));
        handlers.close?.(event);
      },
      add: (event) => {
        latest.current.onAdd?.(event.detail);
        handlers.add?.(event);
      },
    },
  });
  const merged = useMergedRef(ref, elementRef);
  // A value from the page selects its tab through DS.tabs (the first one is rendered).
  const lastValue = useRef(value);
  useIsomorphicLayoutEffect(() => {
    if (value === undefined || value === lastValue.current) return;
    lastValue.current = value;
    if (value !== null && controller.current?.get() !== tabId(value)) controller.current?.set(tabId(value));
    if (value !== null) setShown((before) => (before.has(value) ? before : new Set(before).add(value)));
  }, [value]);

  const list = variants(variant);
  const vertical = list.includes('vertical');
  const tabs = items.map((item) => {
    const selected = item.key === initial;
    const tab = createElement('button', {
      key: item.key,
      className: 'ds-tabs__tab',
      role: 'tab',
      type: 'button',
      id: tabId(item.key),
      'aria-selected': selected ? 'true' : 'false',
      'aria-controls': panelId(item.key),
      tabIndex: selected ? 0 : -1,
      'data-label': typeof item.label === 'string' ? item.label : undefined,
      'data-ds-key': String(item.key),
      ...(item.disabled ? { 'aria-disabled': 'true' } : {}),
      ...(item.closable ? { 'aria-keyshortcuts': 'Delete' } : {}),
    }, iconNode(item.icon, 20), item.label,
    item.count === undefined || item.count === null ? null : createElement('span', { className: 'ds-tabs__count' }, createElement('span', { className: 'ds-sr' }, ', '), item.count));
    if (!item.closable) return tab;
    return createElement('span', { key: item.key, className: 'ds-tabs__item', role: 'none' }, tab,
      createElement('button', { className: 'ds-btn ds-btn--quiet ds-btn--icon ds-xs ds-tabs__close', type: 'button', tabIndex: -1, 'aria-hidden': 'true', 'data-tip': t('close') }, iconNode(closeGlyph, 16)));
  });
  const row = createElement('div', {
    ...attributes,
    ref: merged,
    className: cx('ds-tabs', modifiers('ds-tabs', list), optionClasses({ ...options, tone: undefined }), className),
    role: 'tablist',
    ...(label ? { 'aria-label': label } : {}),
    ...(vertical ? { 'aria-orientation': 'vertical' } : {}),
    'data-ds-tabs': '',
    ...(overflow ? { 'data-ds-tabs-overflow': '' } : {}),
    ...(activate === 'manual' ? { 'data-ds-tabs-activate': 'manual' } : {}),
    'data-ds-managed': '',
  }, tabs);
  const panels = items.map((item) => createElement('div', {
    key: item.key,
    className: cx('ds-tabs__panel', panelClassName),
    role: 'tabpanel',
    id: panelId(item.key),
    'aria-labelledby': tabId(item.key),
    tabIndex: 0,
    hidden: item.key !== initial,
  }, !lazy || shown.has(item.key) ? item.panel : null,
  item.closable && (!lazy || shown.has(item.key))
    ? createElement('button', { className: 'ds-btn ds-btn--text', type: 'button', 'data-ds-tabs-close': '' }, t('closeTab', { label: typeof item.label === 'string' ? item.label : '' }))
    : null));
  const bar = overflow || onAdd
    ? createElement('div', { className: 'ds-tabs__bar' }, row,
      onAdd ? createElement('button', { className: 'ds-btn ds-btn--quiet ds-btn--icon ds-tabs__add', type: 'button', 'aria-label': addLabel, 'data-tip': addLabel }, iconNode(plus, 20)) : null)
    : row;
  return vertical
    ? createElement('div', { className: 'ds-tabs__columns' }, bar, createElement('div', null, panels))
    : createElement(Fragment, null, bar, panels);
});
Tabs.displayName = 'Tabs';
