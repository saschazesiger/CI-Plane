/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The shared placer (3.0): where a floating box goes next to its anchor.
 * DS.overlay uses it for the menu and the combobox list, DS.tooltip for the
 * tooltip; a popover of a later phase uses the same options.
 *
 *   DS.position.place(box, anchor, { align: 'center', offset: 8, padding: 8, flip: 'fits', size: false });
 *   DS.position.computePlacement(rect, size, bounds, options);   // the geometry alone, no DOM
 *
 * What it does, in the terms other placers use:
 * - offset: the gap to the anchor (`offset`), on `side` ('bottom', the
 *   default, 'top', 'start', 'end').
 * - flip: `flip: 'room'` (the default) takes the other side when the box
 *   does not fit and the other side has more room; `'fits'` only when it
 *   fits there; `false` never. `crossFlip` does the same for the alignment:
 *   a box aligned with the start edge that leaves the viewport aligns with
 *   the end edge, when that fits.
 * - shift: the box stays `padding` (the collision padding) inside the
 *   bounds on the cross axis, whatever the alignment.
 * - size: `size` (default true) caps the box to the room on its side
 *   (max-height on the block sides, max-width on the inline ones, written
 *   inline, gone again when it fits), so a box larger than its room scrolls
 *   inside instead of covering its anchor.
 * - arrow: `result.arrow` is the anchor's centre along the cross axis, from
 *   the box's edge, kept `arrowPadding` from its corners.
 * - bounds: the viewport by default; clippedBounds(element) narrows it by
 *   every box around the element that clips its overflow.
 *
 * The anchored path (progressive): supportsAnchoring(view) tells whether
 * the engine has the top layer and CSS anchor positioning; anchorPopup()
 * then opens the box as popover="manual" anchored to its anchor, and the
 * engine keeps it there. claimAnchor() and releaseAnchor() count the users
 * of one anchor-name (a tooltip and a popup on one trigger share it).
 *
 * The script path works in fixed coordinates of whatever box a fixed box
 * is relative to: fixedOrigin() tells where that box starts (a transformed
 * host page around an embedded widget), through a probe beside the box that
 * dropProbe() takes out again.
 *
 * What it writes on the box is owned by the caller (DS.overlay's claims);
 * the anchor-name on the anchor is owned here (Symbol.for('ds.owned'), see
 * motion.js), so a live re-render keeps it.
 *
 * ES2022; no import, nothing touches the DOM at import, so it runs under
 * node for the geometry.
 *
 * Progressive:
 * - CSS anchor positioning (anchorName and position-area, both detected):
 *   without them the script places the box (place()).
 */

const viewOf = (element) => element.ownerDocument?.defaultView ?? globalThis;

/**
 * The runtime state record of motion.js under the same symbol of the global
 * registry, for the anchor-name (these two helpers are motion.js's own,
 * repeated here).
 */
const OWNED = Symbol.for('ds.owned');

function own(element, kind, name) {
  if (!element || typeof element !== 'object') return;
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record[kind].set(name, (record[kind].get(name) ?? 0) + 1);
}

function disown(element, kind, name) {
  const map = element?.[OWNED]?.[kind];
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

/**
 * A length in px, to two decimals, as this module writes it.
 * @param {number} value
 * @returns {number}
 */
export function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * A length token as computed on the element, in px (`fallback` outside a theme).
 * @param {Element} element
 * @param {string} token
 * @param {number} fallback
 * @returns {number}
 */
export function pxOf(element, token, fallback) {
  const value = parseFloat(viewOf(element).getComputedStyle?.(element).getPropertyValue(token) ?? '');
  return Number.isFinite(value) ? value : fallback;
}

/* ── The geometry ───────────────────────────────────── */

/**
 * Where a box of `size` goes at the anchor `rect` inside `bounds`: pure
 * geometry, no DOM (see the header for the options). `room` is the room on
 * the side it took and `length` its extent along that axis, capped to the
 * room unless `size` is false.
 * @param {{ left: number, top: number, right: number, bottom: number }} rect
 * @param {{ width: number, height: number }} size
 * @param {{ left: number, top: number, right: number, bottom: number }} bounds
 * @param {{ side?: 'bottom'|'top'|'start'|'end', align?: 'start'|'center'|'end', offset?: number, padding?: number,
 *   flip?: 'room'|'fits'|false, crossFlip?: boolean, shift?: boolean, size?: boolean, rtl?: boolean, arrowPadding?: number }} [options]
 * @returns {{ x: number, y: number, side: 'bottom'|'top'|'start'|'end', flipped: boolean, room: number, length: number, arrow: number }}
 */
export function computePlacement(rect, size, bounds, options = {}) {
  const wanted = options.side ?? 'bottom';
  const offset = options.offset ?? 0;
  const padding = options.padding ?? 0;
  const rtl = options.rtl === true;
  const flip = options.flip ?? 'room';
  const vertical = wanted === 'bottom' || wanted === 'top';

  // The axis the box leaves the anchor on: towards its far end, or its near end.
  const far = wanted === 'bottom' || (wanted === 'end' && !rtl) || (wanted === 'start' && rtl);
  const [from, to, low, high, extent] = vertical
    ? [rect.top, rect.bottom, bounds.top, bounds.bottom, size.height]
    : [rect.left, rect.right, bounds.left, bounds.right, size.width];
  const towardsFar = high - padding - to - offset;
  const towardsNear = from - offset - low - padding;
  const here = far ? towardsFar : towardsNear;
  const there = far ? towardsNear : towardsFar;
  const flipped = extent > here && ((flip === 'room' && there > here) || (flip === 'fits' && extent <= there));
  const goesFar = flipped ? !far : far;
  const room = Math.max(0, flipped ? there : here);
  const length = options.size === false ? extent : Math.min(extent, room);
  const main = goesFar ? to + offset : from - offset - length;

  // The other axis: aligned, flipped to the other edge without room, kept inside.
  const [crossFrom, crossTo, crossLow, crossHigh, crossExtent, inline] = vertical
    ? [rect.left, rect.right, bounds.left, bounds.right, size.width, true]
    : [rect.top, rect.bottom, bounds.top, bounds.bottom, size.height, false];
  const align = options.align ?? 'start';
  const reversed = inline && rtl;
  const startEdge = reversed ? crossTo - crossExtent : crossFrom;
  const endEdge = reversed ? crossFrom : crossTo - crossExtent;
  const fits = (at) => at >= crossLow + padding && at + crossExtent <= crossHigh - padding;
  let cross = (crossFrom + crossTo) / 2 - crossExtent / 2;
  if (align !== 'center') {
    const [first, second] = align === 'start' ? [startEdge, endEdge] : [endEdge, startEdge];
    cross = options.crossFlip && !fits(first) && fits(second) ? second : first;
  }
  if (options.shift !== false) cross = Math.max(crossLow + padding, Math.min(crossHigh - crossExtent - padding, cross));

  const arrowPadding = options.arrowPadding ?? 0;
  const arrow = Math.max(arrowPadding, Math.min(crossExtent - arrowPadding, (crossFrom + crossTo) / 2 - cross));
  const side = vertical ? (goesFar ? 'bottom' : 'top') : (goesFar === !rtl ? 'end' : 'start');
  return vertical
    ? { x: cross, y: main, side, flipped, room, length, arrow }
    : { x: main, y: cross, side, flipped, room, length, arrow };
}

/**
 * The viewport as the bounds of `element`.
 * @param {Element} element
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function viewportBounds(element) {
  const doc = element.ownerDocument;
  const view = viewOf(element);
  return { left: 0, top: 0, right: doc.documentElement.clientWidth || view.innerWidth, bottom: doc.documentElement.clientHeight || view.innerHeight };
}

/**
 * The viewport, narrowed on the block axis by every box around `element`
 * that clips its overflow (a dialog's box, a sheet's body): what an absolute
 * box cannot leave.
 * @param {Element} element
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function clippedBounds(element) {
  const doc = element.ownerDocument;
  const view = viewOf(element);
  const bounds = viewportBounds(element);
  for (let node = element.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (view.getComputedStyle?.(node).overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    bounds.top = Math.max(bounds.top, box.top);
    bounds.bottom = Math.min(bounds.bottom, box.bottom);
  }
  return bounds;
}

/* ── The script's path ──────────────────────────────── */

/** The fixed probe beside each script-placed box, kept while it is placed (fixedOrigin()). */
const probes = new WeakMap();

/**
 * Where (0,0) of a fixed box's containing block sits in the viewport: the
 * viewport's origin, unless a host ancestor (an embedded widget's) has a
 * transform, filter, perspective, will-change or contain: layout/paint and
 * so becomes the box that fixed layers fill. A fixed probe beside
 * `element` tells, whatever transform the element itself has now, read
 * afresh on every call (a transformed host may scroll with the page). The
 * probe stays beside the box until it is no longer placed (dropProbe()),
 * so following a scroll or a resize adds no DOM mutation per frame for the
 * page's observers; data-ds-keep keeps morphs and indicator tracks off it.
 * @param {Element} element
 * @returns {{ left: number, top: number }}
 */
export function fixedOrigin(element) {
  const parent = element.parentNode;
  if (!parent) return { left: 0, top: 0 };
  let probe = probes.get(element);
  if (!probe) {
    probe = element.ownerDocument.createElement('div');
    probe.setAttribute('data-ds-keep', '');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;margin:0;border:0;padding:0;transform:none;translate:none;scale:none;rotate:none;animation:none;transition:none;visibility:hidden;pointer-events:none';
    probes.set(element, probe);
  }
  // Re-inserted only when the box moved (adopted into a dialog, re-rendered).
  if (probe.parentNode !== parent || probe.nextSibling !== element) parent.insertBefore(probe, element);
  const { left, top } = probe.getBoundingClientRect();
  return { left, top };
}

/**
 * Takes the probe of fixedOrigin() out once the box is no longer placed by the script.
 * @param {Element} element
 */
export function dropProbe(element) {
  probes.get(element)?.remove();
  probes.delete(element);
}

/** The boxes whose max-width place() wrote. @type {WeakSet<Element>} */
const widthCapped = new WeakSet();

/**
 * Places `element` at `anchor` by the script (the options of
 * computePlacement(), plus `bounds`, default the viewport; `x` and `y`, the
 * custom properties that take its coordinates, in the terms of the box it is
 * fixed to; none: only the side and the cap). data-placement says the side
 * when it is not the bottom one; the cap is an inline max-height (bottom,
 * top) or max-width (start, end), on the axis the room was measured along.
 * @param {HTMLElement} element
 * @param {Element} anchor
 * @param {{ side?: 'bottom'|'top'|'start'|'end', align?: 'start'|'center'|'end', offset?: number, padding?: number,
 *   flip?: 'room'|'fits'|false, crossFlip?: boolean, shift?: boolean, size?: boolean, arrowPadding?: number,
 *   bounds?: { left: number, top: number, right: number, bottom: number }, x?: string, y?: string }} [options]
 * @returns {ReturnType<typeof computePlacement>|null}
 */
export function place(element, anchor, options = {}) {
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return null;
  const view = viewOf(element);
  const style = element.style;
  const rect = anchor.getBoundingClientRect();
  const capped = options.size !== false;
  if (capped) {
    style.removeProperty('max-height');
    // Only one this module wrote: an inline max-width may be the page's.
    if (widthCapped.delete(element)) style.removeProperty('max-width');
  }
  const size = { width: element.offsetWidth, height: element.offsetHeight };
  const bounds = options.bounds ?? viewportBounds(element);
  const result = computePlacement(rect, size, bounds, { ...options, rtl: view.getComputedStyle?.(anchor).direction === 'rtl' });
  if (capped) {
    const inline = result.side === 'start' || result.side === 'end';
    if ((inline ? size.width : size.height) > result.room) {
      style.setProperty(inline ? 'max-width' : 'max-height', `${round(result.room)}px`);
      if (inline) widthCapped.add(element);
    }
  }
  if (options.x || options.y) {
    const origin = fixedOrigin(element);
    if (options.x) style.setProperty(options.x, `${round(result.x - origin.left)}px`);
    if (options.y) style.setProperty(options.y, `${round(result.y - origin.top)}px`);
  }
  if (result.side === 'bottom') element.removeAttribute('data-placement');
  else element.setAttribute('data-placement', result.side);
  return result;
}

/* ── The anchored path (progressive) ────────────────── */

/**
 * Top layer and CSS anchor positioning, both needed for the anchored path.
 * @param {any} view
 * @returns {boolean}
 */
export function supportsAnchoring(view) {
  const proto = view.HTMLElement?.prototype ?? {};
  return typeof proto.showPopover === 'function' && typeof view.CSS?.supports === 'function'
    && view.CSS.supports('position-area: block-end') && 'anchorName' in view.document.documentElement.style;
}

/**
 * The anchor-names this module wrote, per element, with a count of users:
 * a tooltip and a popup on one trigger (an icon button with a tooltip that
 * opens a menu) share one name, which goes only once neither uses it.
 * @type {WeakMap<Element, { name: string, count: number }>}
 */
const anchorClaims = new WeakMap();

/**
 * The anchor-name to point at `element`: one this module wrote (counted),
 * the page's own (never touched; `mine` false), or a new one written
 * inline, as `nextName()` names it (numbered per page across every copy of
 * ds.js: the caller holds the counter).
 * @param {Element} element
 * @param {() => string} nextName
 * @returns {{ name: string, mine: boolean }}
 */
export function claimAnchor(element, nextName) {
  const held = anchorClaims.get(element);
  if (held) {
    held.count += 1;
    return { name: held.name, mine: true };
  }
  const css = viewOf(element).getComputedStyle(element).getPropertyValue('anchor-name').trim();
  if (css && css !== 'none') return { name: css.split(',')[0].trim(), mine: false };
  const name = nextName();
  /** @type {HTMLElement} */ (element).style.setProperty('anchor-name', name);
  own(element, 'props', 'anchor-name');
  anchorClaims.set(element, { name, count: 1 });
  return { name, mine: true };
}

/**
 * Lets go of a name claimAnchor() gave; the last user removes it.
 * @param {Element|null|undefined} element
 */
export function releaseAnchor(element) {
  const held = element ? anchorClaims.get(element) : null;
  if (!held) return;
  held.count -= 1;
  if (held.count > 0) return;
  anchorClaims.delete(element);
  /** @type {HTMLElement} */ (element).style.removeProperty('anchor-name');
  disown(element, 'props', 'anchor-name');
}

/**
 * Opens `element` anchored in the top layer: popover="manual",
 * data-anchored and position-anchor (the stylesheet holds its
 * position-area). Its side comes from its full height (the CSS cap lifted to
 * measure it): data-placement="top" above; the engine then fits it to the
 * room on that side. Returns whether the anchor-name is one this module
 * wrote, so the caller releases it with releaseAnchor().
 * @param {HTMLElement} element
 * @param {Element} anchor
 * @param {{ nextName: () => string, offset?: number }} options
 * @returns {boolean}
 */
export function anchorPopup(element, anchor, options) {
  element.setAttribute('popover', 'manual');
  element.setAttribute('data-anchored', '');
  const { name, mine } = claimAnchor(anchor, options.nextName);
  const style = element.style;
  style.setProperty('position-anchor', name);
  try {
    element.showPopover();
  } catch {
    // Already open: it stays.
  }
  style.setProperty('max-height', 'none');
  const height = element.offsetHeight;
  style.removeProperty('max-height');
  const offset = options.offset ?? 0;
  const { side } = computePlacement(anchor.getBoundingClientRect(), { width: 0, height }, viewportBounds(element), { offset, padding: offset });
  if (side === 'top') element.setAttribute('data-placement', 'top');
  else element.removeAttribute('data-placement');
  return mine;
}
