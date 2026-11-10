/**
 * Pointer ripple (components/ripple.css): a press on an action grows a
 * circle of its content colour from the point that was pressed, and fades
 * it once the press ends. Without attach() the flat state layer stays the
 * press feedback.
 *
 *   const ripples = DS.ripple.attach(document);   // once, for every action on the page
 *   ripples.release(host);                        // end a running press (no argument: every press)
 *   ripples.destroy();                            // detach() is its deprecated alias (removed in 3.0)
 *
 * attach(root) adds .ds-ripples to the root element (<html> for document),
 * which positions and clips the hosts (ripple.css), and listens once on
 * the root: pointerdown for the pointer, Enter and Space for a centred
 * ripple on a focused host. Hosts: .ds-btn, .ds-chip (the ripple goes into
 * .ds-chip__body), .ds-segmented__option, .ds-drawer__item,
 * :is(button, a).ds-tile, .ds-card--interactive (also the <div> form,
 * whose .ds-card__action stretches over it), .ds-table__sort, the body rows
 * of .ds-table--interactive that hold a .ds-table__row-link (the ripple
 * goes into the row's first cell and covers the row; Enter on
 * .ds-table__row-link or .ds-card__action ripples
 * the row or card; a press on another link or control inside a row or
 * a <div> card is that control's own, so the host gets none), .ds-radio (a radio card, also
 * when its own input is pressed), .ds-combo__toggle, .ds-menu__item,
 * .ds-errors summary, .ds-pressable and [data-ds-ripple]; data-ds-ripple="off" on a host
 * or an ancestor opts out. Disabled, busy, done and aria-disabled hosts (a chip or radio
 * card whose input is disabled, .ds-radio--disabled), switch, checkbox and
 * radio inputs (their halo is the press), and presses other than the
 * primary button get none. Not hosts, by design: inline links
 * (.ds-link-btn, links in text), .ds-check rows, combobox options
 * (pointer-down selects and closes the list) and native field parts.
 *
 * The ripple is <span class="ds-press-ripple" aria-hidden="true"
 * data-ds-keep> with --ds-ripple-x / --ds-ripple-y (its centre, px from the
 * host's padding box) and --ds-ripple-r (the distance to the farthest
 * corner). At most one grows per host. On release it gets
 * .ds-press-ripple--out, not before --ds-dur-instant after the press, and
 * goes once its fade settled. The host carries .ds-pressed from the press
 * to the release, also at least --ds-dur-instant, so a quick click still
 * shows the whole press.
 *
 * A press ends when another element takes the pointer: an ancestor that
 * captures it (a row that drags to scroll, a sortable list) fires
 * gotpointercapture, and the ripple fades as on release. Capture by the
 * host or something inside it (touch captures the pressed element
 * implicitly) keeps the press. release(host) ends a press by hand (a drag
 * library that moves the pointer elsewhere); :active, and with it the
 * flat press layer and the morph, lasts until the button is released.
 *
 * iOS Safari applies :active only on pages with a touchstart listener:
 * attach() adds a passive one.
 *
 * attach() also installs DS.motion.guard() on the root's document or
 * shadow root: a busy or done .ds-btn and an aria-disabled action inside
 * .ds-theme get no click, middle click, Enter, Space, label click or form
 * submission (data-ds-guard="off" opts a control out). It also starts
 * remembering the document's last input (a press or a key) for
 * DS.overlay, whose focus moves outside any input event follow it; that
 * record is shared and stays after destroy().
 *
 * Pinned columns (.ds-table--pin-first): the sticky first cell holds the
 * row link's stretched area and covers the row's ripple, so in an
 * interactive table attach() forwards a click on a row (outside its
 * controls, with no text selected) to the row's .ds-table__row-link
 * (link.click(); Ctrl, Meta or Shift and the middle button open an
 * a[href] in a new tab), unless the page called preventDefault() on it;
 * a middle press there starts no autoscroll. The row ripples in two
 * parts with one centre: a span in the second cell covers the row under
 * the pinned cell, a second span in the pinned cell covers that cell.
 *
 * Chips (D22): attach() also listens for change on .ds-chip__input in a
 * .ds-chips row, the one call that wires control motion. A toggle that
 * keeps every chip on its line plays the check slot's width from where
 * it is to its end (el.animate() on the slot with its CSS timing, so the
 * neighbours follow the reflow and a rapid toggle continues from the
 * current width); a toggle that moves a chip to another line lets the
 * slot land at once and glides the chips to their new places by flip(),
 * each chip on an opaque backing in the colour behind the row (the row's
 * data-ds-glide and --ds-chips-backdrop, for the glide), so a chip never
 * shows the one it crosses through its transparent body. The toggled
 * chip keeps pace on its neighbour's timing: a body that grew is clipped
 * back to its old width and opens with the neighbour's glide
 * (clip-path), and its label glides from where it was (translate), so
 * its edge and the next chip's never overlap; a body that shrank only
 * glides its label. It measures the end layout with the row's
 * data-ds-snap (the slots without their transition) for one forced style
 * pass. A programmatic
 * `checked` change has no event: there CSS alone runs and a wrap jumps,
 * unless the script dispatches one in the same task
 * (`input.checked = next; input.dispatchEvent(new Event('change',
 * { bubbles: true }))`), which glides like a click.
 *
 * ES2022 (Safari 16.4); a module may import from an earlier module (the
 * build bundles it into dist/ds.js as DS.ripple); newer APIs only behind
 * feature detection, named under Progressive:.
 */
import { MOTION_FALLBACKS, flip, guard, motionDuration, motionEasing, settled, travelDuration } from './motion.js';

/** The actions that get a ripple. */
export const RIPPLE_HOSTS = [
  '.ds-btn',
  '.ds-chip',
  '.ds-segmented__option',
  '.ds-drawer__item',
  ':is(button, a).ds-tile',
  '.ds-card--interactive',
  '.ds-table__sort',
  '.ds-table--interactive tbody tr:not(.ds-table__detail):has(.ds-table__row-link)',
  '.ds-radio',
  '.ds-combo__toggle',
  '.ds-menu__item',
  '.ds-errors summary',
  '.ds-dropzone',
  '.ds-pressable',
  '.ds-drawer__toggle',
  '.ds-tabs__tab',
  '[data-ds-ripple]',
  '.ds-list--interactive > .ds-list__item',
  ':is(a, button).ds-kv-list__row',
  '.ds-disclosure > summary',
  ':is(button, a).ds-columns__col',
].join(', ');

/** The link that stands for its host (stretched over a row or a <div> card): Enter on it ripples the host. */
const HOST_LINK = [
  '.ds-table__row-link',
  '.ds-card__action',
  '.ds-list__action',
].join(', ');

/** Hosts whose own input is part of the host: pressing the input ripples the host. */
const OWNS_INPUT = [
  '.ds-chip',
  '.ds-radio',
].join(', ');

/** Controls whose press is their own halo, not a ripple. */
const OWN_PRESS = 'input[type="checkbox"], input[type="radio"], .ds-switch';

/** Hosts a link stretches over (HOST_LINK): their other controls keep their own press. */
const STRETCHED = [
  '.ds-card--interactive',
  '.ds-table--interactive tbody tr:has(.ds-table__row-link)',
  '.ds-list--interactive > .ds-list__item',
].join(', ');

/** What a press inside a stretched host may land on besides its link (the CSS's press exclusion, plus [tabindex]). */
const CONTROLS = 'a[href], button, input, select, textarea, label, summary, [tabindex]';

/**
 * @typedef {object} Press
 * @property {HTMLElement} span  the ripple
 * @property {HTMLElement} [twin]  its part in a pinned first cell (two-part ripple of a pinned row)
 * @property {number} at  when it started (performance.now())
 * @property {boolean} released
 * @property {(() => void)|undefined} [stop]  takes the pointer listeners of the press away
 */

/** The growing ripple of each host. @type {WeakMap<Element, Press>} */
const presses = new WeakMap();

/** The hosts whose press still grows (release() without a host ends them). @type {Set<Element>} */
const pressing = new Set();

/**
 * @typedef {object} RippleHandle
 * @property {() => void} destroy  removes the listeners and .ds-ripples; ripples already shown finish
 * @property {(host?: Element) => void} release  ends the running press of `host`, or every press under the root
 * @property {() => void} detach  deprecated alias of destroy() (removed in 3.0 at the earliest)
 */

/** The handle of each attached root. @type {WeakMap<Node, RippleHandle>} */
const attached = new WeakMap();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The host of an event target inside `root`, or null. */
function hostOf(target, root) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  const host = element?.closest?.(RIPPLE_HOSTS);
  if (!host || !root.contains(host)) return null;
  if (host.closest('[data-ds-ripple="off"]')) return null;
  return host;
}

/** Where the ripple is measured and placed: the chip's body, else the host itself. */
function surfaceOf(host) {
  return host.classList.contains('ds-chip') ? host.querySelector('.ds-chip__body') : host;
}

/**
 * The element the ripple goes into: a table row cannot hold a span, so
 * it goes into the row's first cell (a <td> or a <th> row header),
 * positioned against the row (it covers the row and clips the circle
 * itself, ripple.css).
 */
function holderOf(surface) {
  if (surface.tagName !== 'TR') return surface;
  return (pinnedCell(surface) ? surface.cells[1] : null) ?? surface.cells[0] ?? null;
}

/* ── Pinned columns ────────────────────────────────── */

/** A row of a pinned interactive table (.ds-table--pin-first): what a click on it may forward to. */
const PINNED_ROW = '.ds-table--pin-first.ds-table--interactive tbody tr:not(.ds-table__detail)';

/**
 * The pinned first cell of a table row, when it is pinned now (sticky:
 * stacked rows and print unpin it), else null.
 */
function pinnedCell(row) {
  const cell = row.cells?.[0];
  if (!cell || row.cells.length < 2 || !row.closest('.ds-table--pin-first')) return null;
  return row.ownerDocument.defaultView?.getComputedStyle(cell).position === 'sticky' ? cell : null;
}

/**
 * The part of a row's ripple in its pinned first cell: the same circle
 * (centre and radius), placed against the cell, which paints over the
 * row's own part.
 */
function pinnedTwin(row, rect, left, top, radius) {
  const cell = pinnedCell(row);
  if (!cell) return null;
  const box = cell.getBoundingClientRect();
  const twin = row.ownerDocument.createElement('span');
  twin.className = 'ds-press-ripple';
  twin.setAttribute('aria-hidden', 'true');
  twin.setAttribute('data-ds-keep', '');
  twin.style.setProperty('--ds-ripple-x', `${Math.round((left + rect.left - box.left) * 100) / 100}px`);
  twin.style.setProperty('--ds-ripple-y', `${Math.round((top + rect.top - box.top) * 100) / 100}px`);
  twin.style.setProperty('--ds-ripple-r', `${Math.round(radius * 100) / 100}px`);
  cell.append(twin);
  return twin;
}

/**
 * A click on a row of a pinned interactive table, outside its controls and
 * with no text selected, opens the row's link: the sticky first cell
 * confines the link's stretched area, so the click would open nothing.
 * A plain click clicks the link; Ctrl, Meta or Shift and the middle
 * button open an a[href] in a new tab. A page that called
 * preventDefault() keeps the click. `ownPrevent`: the middle press that
 * led to this auxclick was cancelled by attach() itself (no autoscroll),
 * which some engines carry over to the auxclick. Returns whether it
 * forwarded.
 */
function forwardRowClick(event, root, ownPrevent = false) {
  if ((event.defaultPrevented && !ownPrevent) || (event.button !== 0 && event.button !== 1)) return false;
  const element = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  const row = element?.closest?.(PINNED_ROW);
  if (!row || !root.contains(row)) return false;
  const control = element.closest(CONTROLS);
  if (control && row.contains(control)) return false;
  const link = row.querySelector('.ds-table__row-link');
  if (!link || link.matches(':disabled') || link.getAttribute('aria-disabled') === 'true') return false;
  const view = row.ownerDocument.defaultView;
  // Text selected by a drag ends in a click that opens nothing. Ctrl, Meta and the middle button skip
  // the check: Firefox selects the table cell on Ctrl + click, and nothing selects text with them.
  const selection = view?.getSelection?.();
  if (selection && !selection.isCollapsed && !(event.ctrlKey || event.metaKey || event.button === 1)) return false;
  const away = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey;
  if (away) {
    if (!link.matches('a[href]')) {
      if (event.button !== 0) return false;
      link.click();
      return true;
    }
    event.preventDefault();
    view?.open(/** @type {HTMLAnchorElement} */ (link).href, '_blank', 'noopener');
    return true;
  }
  link.click();
  return true;
}

/** Whether an element is blocked: disabled (also by its <fieldset>) or aria-disabled. */
const blocked = (element) => Boolean(element && (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'));

/**
 * Hosts that take no press: disabled, aria-disabled, busy, done, a chip or
 * radio card whose input is disabled or aria-disabled, a host that a link
 * stretches over (a table, list or kv row, a <div> card) whose link is
 * blocked. `:disabled`, not the property: it also holds for an input in a
 * disabled <fieldset> (`.ds-chips` is one).
 */
function inactive(host) {
  if (blocked(host) || host.getAttribute('aria-busy') === 'true') return true;
  if (host.classList.contains('ds-btn--done') || host.classList.contains('ds-radio--disabled')) return true;
  if (host.matches(OWNS_INPUT) && blocked(host.querySelector('input'))) return true;
  if (host.matches(STRETCHED)) {
    const link = host.querySelector(HOST_LINK);
    if (link && blocked(link)) return true;
  }
  return false;
}

/**
 * Whether a press on `target` belongs to another control inside a host
 * that a link stretches over (a plain link, a field, a label in a row or
 * a <div> card): that control has its own press, so the host neither
 * ripples nor holds .ds-pressed, as its :active layer does not show.
 */
function pressesOther(host, target) {
  if (!host.matches(STRETCHED)) return false;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  const control = element?.closest?.(CONTROLS);
  return Boolean(control && control !== host && host.contains(control) && !control.matches(HOST_LINK));
}

/** Fades a ripple out and removes it once the fade settled. */
function fade(span) {
  span.classList.add('ds-press-ripple--out');
  settled(span, { event: 'transitionend', property: 'opacity' }).then(() => span.remove());
}

/**
 * Releases a press: the ripple fades out (not before --ds-dur-instant after
 * the press) and the host loses .ds-pressed, unless a newer press took over.
 */
function release(host, press) {
  if (press.released) return;
  press.released = true;
  press.stop?.();
  pressing.delete(host);
  const wait = Math.max(0, motionDuration(host, '--ds-dur-instant') - (now() - press.at));
  setTimeout(() => {
    if (presses.get(host) === press) {
      presses.delete(host);
      host.classList.remove('ds-pressed');
    }
    fade(press.span);
    if (press.twin) fade(press.twin);
  }, wait);
}

/**
 * Starts a ripple on `host` at (x, y) in client coordinates, or centred
 * without them; returns the press.
 */
function start(host, x, y) {
  const surface = surfaceOf(host);
  if (!surface) return null;
  const view = surface.ownerDocument?.defaultView;
  // The defensive guard: a ripple outside a positioned host would escape it.
  // A transform makes the box too: WebKit computes a table row static
  // whatever its position, and an interactive row's identity transform
  // (table.css) is what holds its ripple there.
  const style = view?.getComputedStyle(surface);
  if (style?.position === 'static' && style.transform === 'none') return null;
  // One growing ripple per host: a new press fades the one still held.
  const previous = presses.get(host);
  if (previous && !previous.released) {
    previous.released = true;
    previous.stop?.();
    fade(previous.span);
    if (previous.twin) fade(previous.twin);
  }
  const holder = holderOf(surface);
  if (!holder) return null;
  const rect = surface.getBoundingClientRect();
  // The padding box, in the host's own (untransformed) pixels. A table row
  // has no padding box of its own: its border box (a gliding row's
  // translate included, so the circle starts under the pointer).
  const row = surface !== holder;
  const scaleX = !row && surface.offsetWidth ? rect.width / surface.offsetWidth : 1;
  const scaleY = !row && surface.offsetHeight ? rect.height / surface.offsetHeight : 1;
  const width = row ? rect.width : surface.clientWidth;
  const height = row ? rect.height : surface.clientHeight;
  const left = x === undefined ? width / 2 : (x - rect.left) / (scaleX || 1) - (row ? 0 : surface.clientLeft);
  const top = y === undefined ? height / 2 : (y - rect.top) / (scaleY || 1) - (row ? 0 : surface.clientTop);
  const radius = Math.hypot(Math.max(left, width - left), Math.max(top, height - top));
  const span = surface.ownerDocument.createElement('span');
  span.className = 'ds-press-ripple';
  span.setAttribute('aria-hidden', 'true');
  span.setAttribute('data-ds-keep', '');
  span.style.setProperty('--ds-ripple-x', `${Math.round(left * 100) / 100}px`);
  span.style.setProperty('--ds-ripple-y', `${Math.round(top * 100) / 100}px`);
  span.style.setProperty('--ds-ripple-r', `${Math.round(radius * 100) / 100}px`);
  // WebKit gives a transformed row's absolute boxes the table's height:
  // the row's own height keeps the circle inside the row.
  if (row) span.style.height = `${Math.round(height * 100) / 100}px`;
  holder.append(span);
  const twin = row ? pinnedTwin(surface, rect, left, top, radius) : null;
  host.classList.add('ds-pressed');
  /** @type {Press} */
  const press = { span, at: now(), released: false };
  if (twin) press.twin = twin;
  presses.set(host, press);
  pressing.add(host);
  return press;
}

/** Ends the press of `host`, if one is growing. */
function end(host) {
  const press = presses.get(host);
  if (press) release(host, press);
}

/* ── Chips across a wrap ───────────────────────────── */

/** The running width glide of each chip's check slot. @type {WeakMap<Element, Animation>} */
const slotGlides = new WeakMap();

/** A computed time (the first of a list: '0.25s', '50ms') in ms. */
function timeOf(text) {
  const match = /^\s*(-?\d*\.?\d+)(m?s)\s*$/.exec(String(text ?? '').split(',')[0]);
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 0;
}

/** The first easing of a computed list (cubic-bezier() holds commas of its own). */
function easingOf(text) {
  const match = /^\s*([\w-]+\([^)]*\)|[\w-]+)/.exec(String(text ?? ''));
  return match ? match[1] : 'ease';
}

/**
 * Glides the check slot of `body` from `from` to `to` px with the timing
 * the CSS gave it (a slot that is not animated jumps, as without script).
 */
function glideSlot(body, from, to, timing) {
  if (Math.abs(from - to) < 0.5 || !(timing.duration > 0) || typeof body.animate !== 'function') return;
  try {
    const animation = body.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      pseudoElement: '::after',
      duration: timing.duration,
      delay: timing.delay,
      easing: timing.easing,
      fill: 'backwards',
    });
    animation.id = 'ds-chip-slot';
    slotGlides.set(body, animation);
    const done = () => {
      if (slotGlides.get(body) === animation) slotGlides.delete(body);
    };
    animation.finished.then(done, done);
  } catch {
    // No animations of pseudo-elements: the slot lands at once.
  }
}

/** The edge glides of each chip body across a wrap (clip-path and label translate). @type {WeakMap<Element, Animation[]>} */
const edgeGlides = new WeakMap();

/** The right inset of a computed `inset()` clip-path in px (0 for none). */
function insetRight(clip) {
  const match = /^inset\(([^)]*)\)/.exec(String(clip ?? '').trim());
  if (!match) return 0;
  const sides = match[1].split(/\s+round\s+/)[0].trim().split(/\s+/).map((value) => parseFloat(value) || 0);
  return sides.length > 1 ? sides[1] : sides[0] ?? 0;
}

/** The x of a computed `translate` in px (0 for none). */
function translateX(value) {
  return parseFloat(String(value ?? '').split(/\s+/)[0]) || 0;
}

/** What of a body glides along its edge: its children but the check (over the slot, it never moves) and a ripple. */
function labelsOf(body) {
  return Array.from(body.children).filter((child) => !child.matches('.ds-chip__check, .ds-press-ripple'));
}

/**
 * Where a chip body stands in an edge glide: the part of its width still
 * clipped and its label's offset, to continue from on a rapid toggle.
 */
function edgeState(body) {
  const view = body.ownerDocument.defaultView;
  const label = labelsOf(body)[0];
  return { clip: insetRight(view.getComputedStyle(body).clipPath), shift: label ? translateX(view.getComputedStyle(label).translate) : 0 };
}

/** Stops the edge glide of a body (it lands at once). */
function stopEdge(body) {
  for (const animation of edgeGlides.get(body) ?? []) animation.cancel();
  edgeGlides.delete(body);
}

/** el.animate() with the spring's cubic fallback where linear() is unknown. */
function animateEdge(element, keyframes, timing) {
  try {
    return element.animate(keyframes, timing);
  } catch {
    return element.animate(keyframes, { ...timing, easing: /** @type {string} */ (MOTION_FALLBACKS['--ds-ease-spatial']) });
  }
}

/**
 * Across a wrap the slot of a toggled chip lands at once while flip()
 * glides its neighbours: the body keeps pace on the timing of the next
 * chip on its line (else the travel of `grow` on the spring). A body that
 * grew by `grow` px is clipped back to its old width and opens with the
 * neighbour, so its edge and the neighbour's never overlap; its label
 * glides from where it was. A body that shrank cannot paint its old width:
 * its label glides back, clipped to the body. A keyboard ring (an outline)
 * stays inside the clip.
 */
function glideEdge(body, grow, shift, timing) {
  if (typeof body.animate !== 'function' || (Math.abs(grow) < 0.5 && Math.abs(shift) < 0.5)) return;
  const view = body.ownerDocument.defaultView;
  const style = view.getComputedStyle(body);
  const radius = parseFloat(style.borderTopRightRadius) || 0;
  const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
    ? Math.max(0, parseFloat(style.outlineOffset) || 0) + parseFloat(style.outlineWidth) + 1
    : 0;
  const clip = (right) => `inset(${-ring}px ${Math.round(right * 100) / 100}px ${-ring}px ${-ring}px round ${radius + ring}px)`;
  const options = { duration: timing.duration, easing: timing.easing };
  const running = [];
  try {
    running.push(animateEdge(body, [{ clipPath: clip(Math.max(0, grow)) }, { clipPath: clip(0) }], options));
    if (Math.abs(shift) >= 0.5) {
      for (const label of labelsOf(body)) running.push(animateEdge(label, [{ translate: `${Math.round(shift * 100) / 100}px 0px` }, { translate: '0px 0px' }], options));
    }
  } catch {
    // No such animations: the body lands at once.
    for (const animation of running) animation.cancel();
    return;
  }
  for (const animation of running) animation.id = 'ds-chip-edge';
  edgeGlides.set(body, running);
  const done = () => {
    if (edgeGlides.get(body) === running) edgeGlides.delete(body);
  };
  Promise.allSettled(running.map((animation) => animation.finished)).then(done);
}

/** The timing of a running ds-flip glide of `element`, or null. */
function flipTiming(element) {
  const animation = element?.getAnimations?.().find((item) => item.id === 'ds-flip' && item.playState !== 'finished' && item.playState !== 'idle');
  const timing = animation?.effect?.getTiming?.();
  return timing && Number(timing.duration) > 0 ? { duration: Number(timing.duration), easing: timing.easing || 'linear' } : null;
}

/**
 * The runtime state a DS helper owns on an element right now, which
 * DS.dom.morphHtml keeps (present or absent) until the helper lets go:
 * the record of motion.js under the same symbol of the global registry.
 * These two helpers are motion.js's own, repeated here.
 */
const OWNED = Symbol.for('ds.owned');

/** `kind`: 'attrs', 'classes' or 'props' (a style property, kebab-case). */
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

/** Chip rows that carry the glide backing (owned once, however often backChips() runs). */
const backedRows = new WeakSet();

/** Whether a computed colour paints anything (alpha above 0). */
function paints(colour) {
  if (!colour || colour === 'transparent') return false;
  const inner = /\(([^)]*)\)/.exec(colour)?.[1] ?? '';
  const slash = inner.split('/');
  if (slash.length > 1) return parseFloat(slash[1]) > 0;
  const parts = inner.split(',');
  return parts.length === 4 ? parseFloat(parts[3]) > 0 : true;
}

/** The colour behind `element`: the background of the nearest ancestor (itself included) that paints one. */
function backdropOf(element) {
  const view = element.ownerDocument.defaultView;
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const colour = view.getComputedStyle(node).backgroundColor;
    if (paints(colour)) return colour;
  }
  return '';
}

/**
 * While chips glide across a wrap, each chip gets an opaque backing in the
 * colour behind the row (data-ds-glide, --ds-chips-backdrop): a chip that
 * crosses another, transparent or still fading to its fill, never shows
 * the other one through it. At rest the backing matches what is behind.
 * Both are owned while they last, so a re-render of an ancestor
 * (DS.dom.morphHtml) mid-glide keeps them.
 */
function backChips(row) {
  if (!backedRows.has(row)) {
    backedRows.add(row);
    own(row, 'attrs', 'data-ds-glide');
    own(row, 'props', '--ds-chips-backdrop');
  }
  const backdrop = backdropOf(row);
  if (backdrop) row.style.setProperty('--ds-chips-backdrop', backdrop);
  else row.style.removeProperty('--ds-chips-backdrop');
  row.setAttribute('data-ds-glide', '');
}

/** Takes the backing away once no chip of `row` glides any more. */
function unbackChips(row) {
  const running = Array.from(row.children).flatMap((child) => child.getAnimations?.() ?? [])
    .filter((animation) => animation.id === 'ds-flip' && animation.playState !== 'finished' && animation.playState !== 'idle');
  if (running.length) {
    Promise.allSettled(running.map((animation) => animation.finished)).then(() => unbackChips(row));
    return;
  }
  row.removeAttribute('data-ds-glide');
  row.style.removeProperty('--ds-chips-backdrop');
  if (backedRows.delete(row)) {
    disown(row, 'attrs', 'data-ds-glide');
    disown(row, 'props', '--ds-chips-backdrop');
  }
}

/**
 * A chip of `row` was toggled (its transitions have not advanced yet):
 * the slots glide, or, when a chip changes its line, the chips do.
 */
function chipToggled(row) {
  const view = row.ownerDocument.defaultView;
  const bodies = Array.from(row.querySelectorAll('.ds-chip__body'));
  const children = Array.from(row.children);
  const tops = children.map((child) => child.getBoundingClientRect().top);
  // Where an edge glide in flight stands, then it lands (flip() measures the bodies unclipped).
  const edges = bodies.map((body) => {
    const state = edgeGlides.has(body) ? edgeState(body) : { clip: 0, shift: 0 };
    stopEdge(body);
    return state;
  });
  let wrapped = false;
  /** @type {{ body: Element, grow: number, shift: number, next: Element|null }[]} */
  let toggled = [];
  const glide = flip(row, () => {
    // Where each slot is now (the old width, or a glide in flight) and the timing of its new state.
    const slots = bodies.map((body) => {
      const style = view.getComputedStyle(body, '::after');
      return {
        body,
        from: parseFloat(style.width) || 0,
        timing: { duration: timeOf(style.transitionDuration), delay: timeOf(style.transitionDelay), easing: easingOf(style.transitionTimingFunction) },
      };
    });
    for (const body of bodies) {
      slotGlides.get(body)?.cancel();
      slotGlides.delete(body);
    }
    // The end layout: the slots at their end width.
    row.setAttribute('data-ds-snap', '');
    wrapped = children.some((child, index) => Math.abs(child.getBoundingClientRect().top - tops[index]) > 1);
    const ends = slots.map((slot) => parseFloat(view.getComputedStyle(slot.body, '::after').width) || 0);
    if (wrapped) {
      // The bodies whose slot changes, each with the next item on its line in the end layout.
      toggled = slots.map((slot, index) => {
        const grow = ends[index] - slot.from;
        const chip = slot.body.closest('.ds-chip');
        const next = chip?.parentElement === row ? chip.nextElementSibling : null;
        const same = next && Math.abs(next.getBoundingClientRect().top - chip.getBoundingClientRect().top) <= 1;
        return { body: slot.body, grow: grow + edges[index].clip, shift: edges[index].shift - grow, next: same ? next : null };
      }).filter((entry) => Math.abs(entry.grow) >= 0.5 || Math.abs(entry.shift) >= 0.5);
    }
    // Measured (a forced style pass): the slots keep their end width without a new transition.
    row.removeAttribute('data-ds-snap');
    // A chip changed its line: flip() glides every chip from its old place, each on its backing.
    if (wrapped) {
      backChips(row);
      return;
    }
    // Same lines: the slots glide from where they were (flip() then finds nothing moved).
    slots.forEach((slot, index) => glideSlot(slot.body, slot.from, ends[index], slot.timing));
  });
  if (!wrapped) return;
  // flip() has started its glides: each toggled body keeps pace with the next chip on its line.
  for (const entry of toggled) {
    const timing = flipTiming(entry.next) ?? {
      duration: travelDuration(row, Math.abs(entry.grow)),
      easing: motionEasing(row, '--ds-ease-spatial'),
    };
    glideEdge(entry.body, entry.grow, entry.shift, timing);
  }
  glide.then(() => unbackChips(row), () => unbackChips(row));
}

/** Enter activates buttons and links, Space buttons and inputs (not links, not on Enter for checkboxes). */
function activates(target, key) {
  if (key === ' ') return target.tagName !== 'A';
  if (key === 'Enter') return !target.matches?.('input[type="checkbox"], input[type="radio"]');
  return false;
}

/** Keys that alone never ask for the keyboard ring (js/overlay.js keeps the same list). */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * The last input of a document for js/overlay.js (a focus it moves outside
 * any input event follows it): the record under Symbol.for('ds.input'),
 * installed once by whichever of attach(), DS.overlay.open() and
 * DS.overlay.tooltips() comes first, also across copies of ds.js.
 */
function watchInput(doc) {
  const key = Symbol.for('ds.input');
  if (typeof doc?.addEventListener !== 'function' || doc[key]) return;
  const record = (doc[key] = { last: '' });
  for (const type of ['pointerdown', 'mousedown']) doc.addEventListener(type, () => { record.last = 'pointer'; }, { capture: true, passive: true });
  doc.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (!MODIFIER_KEYS.has(event.key)) record.last = 'key';
  }, true);
}

/**
 * Adds the pointer ripple to every action inside `root` (delegated, so
 * actions rendered later have it too), and installs the action guard
 * (DS.motion.guard()) on its document or shadow root, so busy, done and
 * aria-disabled actions are blocked for every input. Idempotent per root.
 * An open shadow root works as a root too: the listeners go on it (events
 * keep their real targets there) and .ds-ripples on the .ds-theme inside
 * it, where ds.css applies.
 * Returns a handle: destroy() takes it all back (its hold on the guard
 * too; busy() keeps its own), release(host?) ends a running press (the
 * ripple fades as on release; without a host every press under the root;
 * nothing when there is none). detach() is the deprecated alias of
 * destroy().
 * @param {Document|Element|ShadowRoot} [root]
 * @returns {RippleHandle}
 */
export function attach(root = document) {
  const existing = attached.get(root);
  if (existing) return existing;
  const element = /** @type {Element} */ (root.nodeType === 9 ? /** @type {Document} */ (root).documentElement : root);
  const marked = root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).querySelector('.ds-theme') ?? /** @type {ShadowRoot} */ (root).host : element;
  const doc = element.ownerDocument;
  watchInput(doc);
  /** The pending blur that ends a key press, per focused target. @type {WeakMap<Element, () => void>} */
  const blurs = new WeakMap();

  const onPointerDown = (/** @type {PointerEvent} */ event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const host = hostOf(event.target, element);
    if (!host || inactive(host)) return;
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.(OWN_PRESS) && !host.matches(OWNS_INPUT)) return;
    if (pressesOther(host, target)) return;
    const press = start(host, event.clientX, event.clientY);
    if (!press) return;
    const pointer = event.pointerId;
    const stop = () => {
      host.removeEventListener('pointerleave', up);
      doc.removeEventListener('pointerup', up, true);
      doc.removeEventListener('pointercancel', up, true);
      doc.removeEventListener('gotpointercapture', captured, true);
    };
    const up = () => {
      stop();
      end(host);
    };
    // Another element took the pointer (an ancestor that drags to scroll): the press is over.
    const captured = (/** @type {PointerEvent} */ capture) => {
      if (capture.pointerId !== pointer) return;
      const owner = /** @type {Node} */ (capture.target);
      if (owner && owner.nodeType === 1 && host.contains(owner)) return;
      up();
    };
    press.stop = stop;
    host.addEventListener('pointerleave', up);
    doc.addEventListener('pointerup', up, true);
    doc.addEventListener('pointercancel', up, true);
    doc.addEventListener('gotpointercapture', captured, true);
  };

  const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    const target = /** @type {Element} */ (event.target);
    const host = hostOf(target, element);
    if (!host || inactive(host) || !activates(target, event.key)) return;
    // The host itself, the input of a chip or radio card, or the link that stands for a row or card
    // (typing in a field inside a host is no press).
    if (target !== host && !(host.matches(OWNS_INPUT) && target.tagName === 'INPUT') && !target.matches?.(HOST_LINK)) return;
    if (!start(host)) return;
    // One pending blur per target: a key press ended by keyup takes its own
    // away, so a stepper pressed again and again keeps no stale listeners.
    const stale = blurs.get(target);
    if (stale) target.removeEventListener('blur', stale);
    const leave = () => {
      blurs.delete(target);
      target.removeEventListener('blur', leave);
      end(host);
    };
    blurs.set(target, leave);
    target.addEventListener('blur', leave);
  };

  const onKeyUp = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = /** @type {Element} */ (event.target);
    const pending = blurs.get(target);
    if (pending) {
      target.removeEventListener('blur', pending);
      blurs.delete(target);
    }
    const host = hostOf(target, element);
    if (host) end(host);
  };

  // A passive no-op: iOS Safari applies :active only with a touchstart listener.
  const onTouchStart = () => {};

  // The row whose middle press attach() cancelled (Chromium marks the auxclick that follows as prevented too).
  /** @type {Element|null} */
  let middleRow = null;

  // Pinned rows: a click on the row opens its link (bubble phase, after the page's own handlers).
  const onRowClick = (/** @type {MouseEvent} */ event) => {
    const own = event.type === 'auxclick' && middleRow !== null && middleRow.contains(/** @type {Node} */ (event.target));
    if (event.type === 'auxclick') middleRow = null;
    forwardRowClick(event, element, own);
  };

  // A middle press on a pinned row opens its link in a new tab, never the platform autoscroll.
  const onRowMouseDown = (/** @type {MouseEvent} */ event) => {
    middleRow = null;
    if (event.button !== 1 || event.defaultPrevented) return;
    const target = /** @type {Element} */ (event.target);
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    const row = node?.closest?.(PINNED_ROW);
    if (!row || !element.contains(row) || !row.querySelector('a[href].ds-table__row-link') || node.closest(CONTROLS)) return;
    event.preventDefault();
    middleRow = row;
  };

  const onChange = (/** @type {Event} */ event) => {
    const input = /** @type {Element} */ (event.target);
    if (!input?.matches?.('.ds-chip__input')) return;
    const row = input.closest('.ds-chips');
    if (row && element.contains(row)) chipToggled(row);
  };

  marked.classList.add('ds-ripples');
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('keydown', onKeyDown);
  element.addEventListener('keyup', onKeyUp);
  element.addEventListener('touchstart', onTouchStart, { passive: true });
  element.addEventListener('change', onChange);
  element.addEventListener('click', onRowClick);
  element.addEventListener('auxclick', onRowClick);
  element.addEventListener('mousedown', onRowMouseDown);
  // The action guard (DS.motion.guard()) of the document or shadow root:
  // a busy, done or aria-disabled action is blocked for every input.
  const rootNode = root.nodeType === 9 || root.nodeType === 11 ? root : element.getRootNode?.() ?? doc;
  const guarded = guard(/** @type {Document|ShadowRoot} */ (rootNode));

  /** @type {RippleHandle} */
  const handle = {
    /** Removes the listeners and .ds-ripples; ripples already shown finish. */
    destroy() {
      if (attached.get(root) !== handle) return;
      attached.delete(root);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('keyup', onKeyUp);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('change', onChange);
      element.removeEventListener('click', onRowClick);
      element.removeEventListener('auxclick', onRowClick);
      element.removeEventListener('mousedown', onRowMouseDown);
      guarded.destroy();
      marked.classList.remove('ds-ripples');
    },
    /** Ends the press of `host` (or of every host under the root) as a release would. */
    release(host) {
      const hosts = host ? [host] : [...pressing].filter((item) => element.contains(item));
      for (const item of hosts) end(item);
    },
    /** Deprecated (removed in 3.0 at the earliest): destroy(). */
    detach() {
      handle.destroy();
    },
  };
  attached.set(root, handle);
  return handle;
}
