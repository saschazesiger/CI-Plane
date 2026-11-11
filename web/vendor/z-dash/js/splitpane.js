/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Split pane (DS.splitpane): two or three panes with a divider between each
 * pair that a pointer drags and the keyboard moves, the WAI-ARIA window
 * splitter. The markup (splitpane.css) holds the start sizes and the limits
 * as custom properties on the panes, so the page is laid out before any
 * script runs.
 *
 *   <div class="ds-splitpane" data-ds-splitpane data-ds-splitpane-store="devices">
 *     <section class="ds-splitpane__pane" id="device-list" data-ds-splitpane-collapsible
 *              style="--ds-splitpane-size: 320px; --ds-splitpane-min: 240px"> ... </section>
 *     <div class="ds-splitpane__divider" role="separator" tabindex="0" aria-controls="device-list" aria-label="Resize the device list"></div>
 *     <section class="ds-splitpane__pane ds-splitpane__pane--fill"> ... </section>
 *   </div>
 *
 *   const split = DS.splitpane.create(el, { store: 'devices' });
 *   split.get();                      // { sizes: [320, null], collapsed: [false, false] }
 *   split.set({ sizes: [400] });      // px, or a CSS length as text ('30%')
 *   split.collapse(0); split.expand(0); split.toggle('device-list'); split.reset();
 *   split.on('change', ({ sizes, collapsed, index }) => { ... });
 *
 * A divider resizes the pane its aria-controls names, else the neighbour
 * that does not fill (.ds-splitpane__pane--fill, else the last pane). Keys
 * on a focused divider: ArrowLeft and ArrowRight (stacked: ArrowUp and
 * ArrowDown) move it by data-ds-splitpane-step px (default 16; with Shift
 * four times that), Home and End to the pane's smallest and largest size,
 * Enter collapses and restores a pane marked data-ds-splitpane-collapsible.
 * A pointer drags it (captured; Escape puts it back where the drag began);
 * a collapsible pane dragged below half its minimum, or moved below its
 * minimum by a key, snaps shut. A double click collapses and restores it (a
 * pane that cannot collapse goes back to its start size). A button with
 * data-ds-splitpane-toggle="<pane id>", anywhere in the page (or the pane's
 * index, inside the split pane), collapses and restores that pane: one
 * delegated listener per root of DS.init(); the module keeps its
 * aria-expanded and aria-controls. A pane that collapses while it holds the
 * focus hands it to its divider (else to a toggle of it outside it) before
 * it turns inert. destroy() takes back what the module wrote.
 *
 * The divider's value (aria-valuenow, -min, -max) is the pane's share of the
 * room the dividers leave, in percent; a collapsed pane reads
 * aria-valuetext t('splitpaneCollapsed'). The page names each divider
 * (aria-label); one without a name gets t('splitpaneResize').
 *
 * A size keeps the unit the markup gave it: a percentage stays a share of
 * the split pane when it resizes, anything else is written in px. The
 * browser holds the limits (min- and max-inline-size) and shrinks the panes
 * when the split pane gets narrower; a move is clamped to the same limits
 * and to the room the other panes leave.
 *
 * data-ds-splitpane-store="<key>" keeps the sizes and the collapsed panes in
 * DS.store (namespace 'splitpane'), restored at init when the number of
 * panes still matches. ds:change ({ sizes, collapsed, index }) goes out after
 * a drag, a key, a toggle or set(), never during a drag.
 *
 * Collapsing and restoring glide (splitpane.css: data-state="collapsed",
 * then "expanding" until the size arrived, DS.motion.settled); a drag and
 * the keys move at once. No ms literal.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, get, t } from './core.js';
import { settled } from './motion.js';
import { open as openStore } from './store.js';
import { canTakeFocus } from './a11y.js';

const DEFAULT_STEP = 16;
const BIG_STEP = 4;
const PANE = 'ds-splitpane__pane';
const DIVIDER = 'ds-splitpane__divider';
const FILL = 'ds-splitpane__pane--fill';
const TOGGLE = 'data-ds-splitpane-toggle';
const SIZE = '--ds-splitpane-size';
/** The divider attributes the module writes, put back as the markup had them by destroy(). */
const DIVIDER_ATTRS = ['role', 'tabindex', 'aria-orientation', 'aria-label', 'aria-controls', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext'];

let uid = 0;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const isIndex = (ref) => /^\d+$/.test(String(ref).trim());

/**
 * A computed length in px: `px`, a percentage of `total`, or the
 * `calc(<a>% + <b>px)` the engines compute a mixed length to. Null for what
 * names no length (`none`, `auto`, empty, another unit).
 * @param {string|null|undefined} text
 * @param {number} total
 * @returns {number|null}
 */
export function toPixels(text, total) {
  const value = String(text ?? '').trim();
  const plain = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|%)$/.exec(value);
  if (plain) return plain[2] === '%' ? (Number(plain[1]) / 100) * total : Number(plain[1]);
  const mixed = /^calc\(\s*(-?\d*\.?\d+)(px|%)\s*([+-])\s*(\d*\.?\d+)(px|%)\s*\)$/.exec(value);
  if (!mixed || mixed[2] === mixed[5]) return null;
  const part = (number, unit) => (unit === '%' ? (Number(number) / 100) * total : Number(number));
  return part(mixed[1], mixed[2]) + (mixed[3] === '-' ? -1 : 1) * part(mixed[4], mixed[5]);
}

/**
 * The size of a pane after a key or a drag, or null for a key that does
 * nothing here. `state.size` is the pane's open size (kept while it is
 * collapsed, so it comes back to it); `sign` is 1 when the pane lies before
 * the divider (ArrowRight and ArrowDown grow it), -1 after it; `to` is the
 * size a drag asks for.
 * @param {{ size: number, min: number, max: number, collapsed?: boolean, collapsible?: boolean, step?: number }} state
 * @param {{ key?: string, shift?: boolean, sign?: number, axis?: 'x'|'y', to?: number }} input
 * @returns {{ size: number, collapsed: boolean }|null}
 */
export function nextSize(state, input) {
  const { min, max } = state;
  const collapsible = Boolean(state.collapsible);
  const collapsed = collapsible && Boolean(state.collapsed);
  if (typeof input.to === 'number') {
    if (collapsible && input.to < min / 2) return { size: state.size, collapsed: true };
    return { size: clamp(input.to, min, max), collapsed: false };
  }
  const grow = input.axis === 'y' ? 'ArrowDown' : 'ArrowRight';
  const shrink = input.axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
  const step = (state.step ?? DEFAULT_STEP) * (input.shift ? BIG_STEP : 1);
  switch (input.key) {
    case grow:
    case shrink: {
      const delta = (input.key === grow ? 1 : -1) * (input.sign ?? 1) * step;
      if (collapsed) return delta > 0 ? { size: clamp(Math.max(min, step), min, max), collapsed: false } : { size: state.size, collapsed: true };
      if (delta < 0 && collapsible && state.size <= min + 0.5) return { size: state.size, collapsed: true };
      return { size: clamp(state.size + delta, min, max), collapsed: false };
    }
    case 'Home':
      return { size: clamp(min, min, max), collapsed: false };
    case 'End':
      return { size: clamp(max, min, max), collapsed: false };
    case 'Enter':
      return collapsible ? { size: state.size, collapsed: !collapsed } : null;
    default:
      return null;
  }
}

const isPane = (node) => node.classList?.contains(PANE);
const isDivider = (node) => node.classList?.contains(DIVIDER);

function controller(el, options, signal) {
  const doc = el.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const listeners = new Set();
  let key = options.store || '';
  let prefs = key ? openStore('splitpane') : null;
  const stepOf = (value) => (Number(value) > 0 ? Number(value) : DEFAULT_STEP);
  let step = stepOf(options.step);
  /**
   * Per pane: its element, the size it opens to as CSS text (`text`, in the
   * unit of the markup), whether that unit is a percentage, the markup's
   * own inline value and computed value (reset()), collapsed.
   * @type {{ el: HTMLElement, text: string, percent: boolean, inline: string, start: string, collapsed: boolean, token: number }[]}
   */
  let panes = [];
  /** @type {{ el: HTMLElement, pane: any, sign: number }[]} */
  let dividers = [];
  let drag = null;
  /** The markup's own attributes of each divider, for destroy(). */
  const original = new Map();

  const axis = () => (el.classList.contains('ds-splitpane--stacked') || el.getAttribute('data-state') === 'stacked' ? 'y' : 'x');
  const stackOf = (value) => (Number(value) > 0 ? Number(value) : 0);
  let stackBelow = stackOf(options.stack);
  const extent = (node) => {
    const rect = node.getBoundingClientRect();
    return axis() === 'y' ? rect.height : rect.width;
  };
  const total = () => (axis() === 'y' ? el.clientHeight : el.clientWidth);
  const fillIndex = () => {
    const marked = panes.findIndex((pane) => pane.el.classList.contains(FILL));
    return marked >= 0 ? marked : panes.length - 1;
  };
  const isFill = (pane) => panes.indexOf(pane) === fillIndex();
  const computed = (node, name) => view.getComputedStyle(node).getPropertyValue(name).trim();
  const collapsible = (pane) => pane.el.hasAttribute('data-ds-splitpane-collapsible');
  /** The open size of a pane in px. */
  const sizeOf = (pane) => toPixels(pane.text, total()) ?? extent(pane.el);
  /** A size in px as the pane's text, in its unit. */
  const textOf = (pane, px) => {
    const whole = total();
    return pane.percent && whole > 0 ? `${Number(((px / whole) * 100).toFixed(3))}%` : `${Math.round(px * 100) / 100}px`;
  };

  function scan() {
    const children = [...el.children];
    panes = children.filter(isPane).map((node) => {
      const start = computed(node, SIZE) || '50%';
      const shut = node.getAttribute('data-state') === 'collapsed';
      return { el: node, text: start, percent: start.endsWith('%'), inline: node.style.getPropertyValue(SIZE), start, collapsed: shut, token: 0 };
    });
    const fill = fillIndex();
    dividers = children.filter(isDivider).map((node) => {
      const before = panes.filter((pane) => node.compareDocumentPosition(pane.el) & 2).at(-1);
      const after = panes.find((pane) => node.compareDocumentPosition(pane.el) & 4);
      const named = node.getAttribute('aria-controls');
      const usable = (pane) => Boolean(pane) && panes.indexOf(pane) !== fill;
      const target = [before, after].find((pane) => usable(pane) && named && pane.el.id === named)
        ?? (usable(before) ? before : usable(after) ? after : null);
      return { el: node, pane: target, sign: target === before ? 1 : -1 };
    });
    for (const divider of dividers) prepare(divider);
  }

  function prepare({ el: node, pane }) {
    if (!original.has(node)) original.set(node, DIVIDER_ATTRS.map((name) => [name, node.getAttribute(name)]));
    if (!node.hasAttribute('role')) node.setAttribute('role', 'separator');
    if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
    node.setAttribute('aria-orientation', axis() === 'y' ? 'horizontal' : 'vertical');
    if (!node.hasAttribute('aria-label') && !node.hasAttribute('aria-labelledby')) node.setAttribute('aria-label', t('splitpaneResize'));
    if (!pane) return;
    if (!pane.el.id) pane.el.id = `ds-splitpane-${(uid += 1)}`;
    node.setAttribute('aria-controls', pane.el.id);
  }

  /** The room of a pane: its own limits and what the other panes leave (their sizes, the filler's minimum). */
  function bounds(pane) {
    const whole = total();
    const available = Math.max(0, whole - dividers.reduce((sum, divider) => sum + extent(divider.el), 0));
    const min = Math.max(0, toPixels(computed(pane.el, '--ds-splitpane-min'), whole) ?? 0);
    const own = toPixels(computed(pane.el, '--ds-splitpane-max'), whole) ?? available;
    const fill = panes[fillIndex()];
    const others = panes.reduce((sum, other) => (other === pane || other === fill || other.collapsed ? sum : sum + extent(other.el)), 0);
    const room = available - others - (fill ? toPixels(computed(fill.el, '--ds-splitpane-min'), whole) ?? 0 : 0);
    return { min, max: Math.max(min, Math.min(own, room)), available };
  }

  const write = (pane) => pane.el.style.setProperty(SIZE, pane.collapsed ? (pane.percent ? '0%' : '0px') : pane.text);

  /** The toggles that name a pane of this split pane: by id anywhere, by index inside it. */
  function toggles() {
    return [...doc.querySelectorAll(`[${TOGGLE}]`)].filter((node) => paneOf(node.getAttribute(TOGGLE), node));
  }

  function paneOf(ref, from) {
    if (ref === null || ref === undefined || String(ref).trim() === '') return null;
    if (typeof ref === 'number' || isIndex(ref)) {
      if (from && from.closest('.ds-splitpane') !== el) return null;
      return panes[Number(ref)] ?? null;
    }
    return panes.find((pane) => pane.el.id === String(ref).trim()) ?? null;
  }

  function describe() {
    for (const { el: node, pane } of dividers) {
      if (!pane) continue;
      const { min, max, available } = bounds(pane);
      const share = (px) => (available > 0 ? Math.round((px / available) * 100) : 0);
      const now = pane.collapsed ? 0 : Math.min(share(extent(pane.el)), share(max));
      node.setAttribute('aria-valuemin', String(pane.collapsed ? 0 : share(min)));
      node.setAttribute('aria-valuemax', String(share(max)));
      node.setAttribute('aria-valuenow', String(now));
      if (pane.collapsed) node.setAttribute('aria-valuetext', t('splitpaneCollapsed'));
      else node.removeAttribute('aria-valuetext');
    }
    for (const toggle of toggles()) {
      const pane = paneOf(toggle.getAttribute(TOGGLE), toggle);
      if (!pane.el.id) pane.el.id = `ds-splitpane-${(uid += 1)}`;
      toggle.setAttribute('aria-controls', pane.el.id);
      toggle.setAttribute('aria-expanded', String(!pane.collapsed));
    }
  }

  /**
   * Puts a pane into a state. A collapse glides (the transition of
   * data-state="collapsed"); so does a restore with `glides`, through
   * data-state="expanding" until its size arrived.
   */
  function apply(pane, next, glides) {
    const opening = pane.collapsed && !next.collapsed;
    if (next.collapsed && !pane.collapsed) evacuate(pane);
    pane.text = textOf(pane, next.size);
    pane.collapsed = next.collapsed;
    pane.el.inert = next.collapsed;
    const token = (pane.token += 1);
    if (next.collapsed) pane.el.setAttribute('data-state', 'collapsed');
    else if (opening && glides) pane.el.setAttribute('data-state', 'expanding');
    else pane.el.removeAttribute('data-state');
    write(pane);
    if (pane.el.getAttribute('data-state') === 'expanding') {
      settled(pane.el, { transitions: true }).then(() => {
        if (token !== pane.token || signal.aborted) return;
        pane.el.removeAttribute('data-state');
        describe();
      });
    }
    describe();
  }

  /**
   * Moves the focus out of a pane that collapses (a hide button in its own
   * header), before it turns inert: to the divider that controls it, else a
   * toggle of it outside it.
   */
  function evacuate(pane) {
    const active = doc.activeElement;
    if (!active || !pane.el.contains(active)) return;
    const candidates = [
      ...dividers.filter((divider) => divider.pane === pane).map((divider) => divider.el),
      ...toggles().filter((node) => !pane.el.contains(node) && paneOf(node.getAttribute(TOGGLE), node) === pane),
    ];
    candidates.find((node) => canTakeFocus(node))?.focus();
  }

  function state() {
    return {
      sizes: panes.map((pane) => (isFill(pane) ? null : pane.collapsed ? 0 : Math.round(extent(pane.el)))),
      collapsed: panes.map((pane) => pane.collapsed),
    };
  }

  function report(pane) {
    prefs?.set(key, { sizes: panes.map((item) => (isFill(item) ? null : item.text)), collapsed: panes.map((item) => item.collapsed) });
    if (signal.aborted) return;
    const detail = { ...state(), index: pane ? panes.indexOf(pane) : -1 };
    emit(el, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  }

  /** The remembered sizes, at once (no glide): the size first, then the state. */
  function restore() {
    const saved = prefs?.get(key);
    if (!saved || !Array.isArray(saved.sizes) || saved.sizes.length !== panes.length) return;
    panes.forEach((pane, index) => {
      if (isFill(pane)) return;
      const text = saved.sizes[index];
      if (typeof text === 'string' && toPixels(text, 100) !== null) {
        pane.text = text;
        pane.percent = text.trim().endsWith('%');
      }
      pane.collapsed = Boolean(saved.collapsed?.[index]) && collapsible(pane);
    });
  }

  /** The state of every pane, written at once: a collapsed pane gets its size before its state, so nothing glides. */
  function settle() {
    for (const pane of panes) {
      pane.el.inert = pane.collapsed;
      write(pane);
    }
    // A style flush of each collapsed pane (Gecko restyles only what is read),
    // so the state below starts no transition.
    for (const pane of panes) if (pane.collapsed) computed(pane.el, SIZE);
    for (const pane of panes) {
      if (pane.collapsed) pane.el.setAttribute('data-state', 'collapsed');
      else if (pane.el.getAttribute('data-state') === 'collapsed') pane.el.removeAttribute('data-state');
    }
  }

  /** Moves the pane of a divider by a key; saves and reports. */
  function press(divider, input) {
    const pane = divider.pane;
    if (!pane) return false;
    const { min, max } = bounds(pane);
    const size = pane.collapsed ? sizeOf(pane) : extent(pane.el);
    const next = nextSize({ size, min, max, collapsed: pane.collapsed, collapsible: collapsible(pane), step }, { ...input, sign: divider.sign, axis: axis() });
    if (!next) return false;
    // A key that changes nothing (ArrowRight at the largest size, Home at the smallest) reports nothing.
    if (next.collapsed === pane.collapsed && textOf(pane, next.size) === pane.text) return true;
    apply(pane, next, next.collapsed !== pane.collapsed);
    report(pane);
    return true;
  }

  const dividerOf = (event) => dividers.find((item) => item.el === event.currentTarget);

  function onKey(event) {
    const divider = dividerOf(event);
    if (!divider || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (drag) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelDrag();
      return;
    }
    if (press(divider, { key: event.key, shift: event.shiftKey })) event.preventDefault();
  }

  function onPointerDown(event) {
    const divider = dividerOf(event);
    if (!divider?.pane || event.button !== 0 || !event.isPrimary || drag) return;
    // No text selection and no native drag; the focus goes to the divider by hand.
    event.preventDefault();
    divider.el.focus({ preventScroll: true });
    const pane = divider.pane;
    const start = { text: pane.text, collapsed: pane.collapsed };
    // A glide still running stops where it is: the drag starts from there.
    const from = pane.collapsed ? 0 : extent(pane.el);
    if (!pane.collapsed && pane.el.hasAttribute('data-state')) apply(pane, { size: from, collapsed: false }, false);
    drag = { divider, pointer: event.pointerId, origin: axis() === 'y' ? event.clientY : event.clientX, from, start, moved: false };
    try {
      divider.el.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone already: the next up ends the drag.
    }
    divider.el.setAttribute('data-state', 'dragging');
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const at = axis() === 'y' ? event.clientY : event.clientX;
    const delta = (at - drag.origin) * drag.divider.sign;
    if (!drag.moved && Math.abs(delta) < 1) return;
    drag.moved = true;
    const pane = drag.divider.pane;
    const { min, max } = bounds(pane);
    // While shut, the pane keeps the size it opens to: the one the drag began with.
    const open = drag.start.collapsed ? toPixels(drag.start.text, total()) ?? min : drag.from;
    const next = nextSize({ size: open, min, max, collapsible: collapsible(pane) }, { to: drag.from + delta });
    apply(pane, next, next.collapsed !== pane.collapsed);
  }

  function release(divider, pointer) {
    divider.el.removeAttribute('data-state');
    if (pointer !== undefined && divider.el.hasPointerCapture?.(pointer)) divider.el.releasePointerCapture(pointer);
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { divider, moved, pointer } = drag;
    drag = null;
    release(divider, pointer);
    if (moved) report(divider.pane);
  }

  function cancelDrag() {
    if (!drag) return;
    const { divider, start, pointer } = drag;
    drag = null;
    release(divider, pointer);
    const pane = divider.pane;
    apply(pane, { size: toPixels(start.text, total()) ?? sizeOf(pane), collapsed: start.collapsed }, start.collapsed !== pane.collapsed);
  }

  function onDoubleClick(event) {
    const pane = dividerOf(event)?.pane;
    if (!pane) return;
    if (collapsible(pane)) apply(pane, { size: sizeOf(pane), collapsed: !pane.collapsed }, true);
    else apply(pane, { size: toPixels(pane.start, total()) ?? sizeOf(pane), collapsed: false }, false);
    report(pane);
  }

  function toggle(ref) {
    const pane = paneOf(ref);
    if (!pane) return;
    if (pane.collapsed) handle.expand(ref);
    else handle.collapse(ref);
  }

  scan();
  restore();
  settle();
  describe();

  for (const divider of dividers) {
    const opts = { signal };
    divider.el.addEventListener('keydown', onKey, opts);
    divider.el.addEventListener('pointerdown', onPointerDown, opts);
    divider.el.addEventListener('pointermove', onPointerMove, opts);
    divider.el.addEventListener('pointerup', endDrag, opts);
    divider.el.addEventListener('pointercancel', endDrag, opts);
    divider.el.addEventListener('lostpointercapture', endDrag, opts);
    divider.el.addEventListener('dblclick', onDoubleClick, opts);
  }

  /** Stacks the panes while the split pane is narrower than data-ds-splitpane-stack; true when that changed. */
  function fold() {
    if (!stackBelow) return false;
    const narrow = el.getBoundingClientRect().width < stackBelow;
    if (narrow === (el.getAttribute('data-state') === 'stacked')) return false;
    if (drag) cancelDrag();
    if (narrow) el.setAttribute('data-state', 'stacked');
    else el.removeAttribute('data-state');
    for (const divider of dividers) prepare(divider);
    return true;
  }

  fold();
  describe();

  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => {
    fold();
    describe();
  }) : null;
  resize?.observe(el);

  const handle = {
    get: state,
    set(value = {}) {
      const sizes = Array.isArray(value) ? value : value.sizes;
      const shut = Array.isArray(value) ? null : value.collapsed;
      let moved = null;
      for (const [index, pane] of panes.entries()) {
        if (isFill(pane)) continue;
        const raw = sizes?.[index];
        const next = { size: sizeOf(pane), collapsed: pane.collapsed };
        const px = typeof raw === 'number' ? raw : typeof raw === 'string' ? toPixels(raw, total()) : null;
        if (px !== null && Number.isFinite(px)) {
          if (typeof raw === 'string') pane.percent = raw.trim().endsWith('%');
          const { min, max } = bounds(pane);
          next.size = clamp(px, min, max);
        }
        if (typeof shut?.[index] === 'boolean' && (collapsible(pane) || !shut[index])) next.collapsed = shut[index];
        if (textOf(pane, next.size) === pane.text && next.collapsed === pane.collapsed) continue;
        apply(pane, next, next.collapsed !== pane.collapsed);
        moved = moved === null ? pane : moved;
      }
      if (moved) report(moved);
    },
    collapse(ref) {
      const pane = paneOf(ref);
      if (!pane || pane.collapsed || isFill(pane)) return;
      apply(pane, { size: sizeOf(pane), collapsed: true }, true);
      report(pane);
    },
    expand(ref) {
      const pane = paneOf(ref);
      if (!pane || !pane.collapsed) return;
      apply(pane, { size: sizeOf(pane), collapsed: false }, true);
      report(pane);
    },
    toggle,
    reset() {
      prefs?.remove(key);
      for (const pane of panes) {
        pane.token += 1;
        if (pane.inline) pane.el.style.setProperty(SIZE, pane.inline);
        else pane.el.style.removeProperty(SIZE);
        pane.el.removeAttribute('data-state');
        pane.el.inert = false;
        pane.collapsed = false;
        pane.text = pane.start;
        pane.percent = pane.start.endsWith('%');
      }
      describe();
      if (signal.aborted) return;
      const detail = { ...state(), index: -1 };
      emit(el, 'change', detail);
      listeners.forEach((fn) => fn(detail));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The attribute path: an option attribute changed (so the panes keep their sizes, no new controller). */
    update(names = []) {
      if (names.includes('data-ds-splitpane-step')) step = stepOf(el.getAttribute('data-ds-splitpane-step'));
      if (names.includes('data-ds-splitpane-stack')) {
        stackBelow = stackOf(el.getAttribute('data-ds-splitpane-stack'));
        if (!stackBelow && el.getAttribute('data-state') === 'stacked') {
          cancelDrag();
          el.removeAttribute('data-state');
          for (const divider of dividers) prepare(divider);
        } else fold();
      }
      if (names.includes('data-ds-splitpane-store')) {
        const next = el.getAttribute('data-ds-splitpane-store') || '';
        if (next !== key) {
          prefs?.destroy();
          key = next;
          prefs = key ? openStore('splitpane') : null;
          restore();
          settle();
        }
      }
      describe();
    },
    destroy() {
      cancelDrag();
      if (stackBelow && el.getAttribute('data-state') === 'stacked') el.removeAttribute('data-state');
      resize?.disconnect();
      // What the module wrote goes, so no pane stays shut and inert with nothing left to open it.
      for (const pane of panes) {
        pane.token += 1;
        pane.el.inert = false;
        pane.el.removeAttribute('data-state');
        if (pane.inline) pane.el.style.setProperty(SIZE, pane.inline);
        else pane.el.style.removeProperty(SIZE);
      }
      for (const [node, attrs] of original) {
        for (const [name, value] of attrs) {
          if (value === null) node.removeAttribute(name);
          else node.setAttribute(name, value);
        }
      }
      original.clear();
      listeners.clear();
      prefs?.destroy();
    },
  };
  return handle;
}

define('splitpane', {
  attribute: 'data-ds-splitpane',
  attributes: ['data-ds-splitpane-store', 'data-ds-splitpane-step', 'data-ds-splitpane-stack'],
  init(el, ctx) {
    return controller(el, {
      store: el.getAttribute('data-ds-splitpane-store'),
      step: el.getAttribute('data-ds-splitpane-step'),
      stack: el.getAttribute('data-ds-splitpane-stack'),
    }, ctx.signal);
  },
  // A toggle anywhere: by the id of a pane, or by its index inside the split pane.
  global(root) {
    const onClick = (event) => {
      const button = event.target?.closest?.(`[${TOGGLE}]`);
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      const ref = (button.getAttribute(TOGGLE) ?? '').trim();
      const split = isIndex(ref) ? button.closest('.ds-splitpane') : button.ownerDocument.getElementById(ref)?.parentElement;
      const handle = split ? get(split, 'splitpane') : null;
      handle?.toggle?.(isIndex(ref) ? Number(ref) : ref);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  },
});

/**
 * A split pane driven from the page; the same controller the attribute path
 * makes (its toggle buttons need DS.init(), or call toggle()). `store` names
 * the remembered sizes (DS.store), `step` the px a key moves a divider,
 * `stack` the width in px under which the panes stack.
 * @param {Element} el
 * @param {{ store?: string, step?: number, stack?: number }} [options]
 */
export function create(el, options = {}) {
  const abort = new AbortController();
  const handle = controller(el, { store: options.store ?? '', step: options.step, stack: options.stack }, abort.signal);
  const destroy = handle.destroy;
  handle.destroy = () => {
    destroy();
    abort.abort();
  };
  return handle;
}
