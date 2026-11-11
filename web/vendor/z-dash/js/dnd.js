/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Drag and drop (3.0): pointer and keyboard moves with announcements, the
 * engine under kanban boards, trees and panel grids. DS.motion.sortable()
 * stays what it is, one list with a grip; a page that needs more than one
 * zone, a drop it can refuse or its own placement uses this.
 *
 *   const drag = DS.dnd.create(board, {
 *     zones: '.ex-column',
 *     items: '.ex-card',
 *     handle: '.ds-grip',
 *     label: (card) => card.dataset.title,
 *   });
 *   board.addEventListener('ds:drop', ({ detail }) => save(detail.item, detail.to));
 *   drag.destroy();
 *
 * Pointer: a press on a handle and a move of DRAG_THRESHOLD px lift the item
 * (a press without a move stays a click; a drag never ends in one, so a handle
 * that also opens its card does not open it). It follows the pointer (its inline
 * translate) and carries data-ds-dragging (drag.css: raised, the dragged state
 * layer; nothing scales). Whenever the target changes, the item moves in the
 * DOM and the others make room through flip() (a move during a glide continues
 * from where each item is). Near the edge of a scrollable ancestor, that
 * ancestor scrolls. On release it glides into place on the spring. A zone with
 * the item over it carries data-ds-dragover when there are several.
 *
 * Keyboard: on a handle, Space or Enter lifts. Arrows and Home/End then move
 * the item (along the axis inside a zone, across it to the next zone that
 * accepts it; with axis 'both' an arrow with nowhere left in the zone goes on to
 * the next one or the one before) and keep it in view; the handle keeps the
 * focus. Space or Enter drops, Escape cancels (and keeps an open dialog open),
 * and a focus that leaves or a handle that goes cancels: Tab is never held. A
 * held Space or Enter counts once; held arrows repeat. The position is spoken
 * at each step through a polite .ds-sr region in the list's modal, else its
 * .ds-theme, there from create() on (a reader can miss the first change to a
 * region that has only just appeared); a hint hangs off the focused handle by
 * aria-describedby.
 *
 * A cancel (Escape, pointercancel, a lost capture, destroy()) or a refused drop
 * puts the item back where it was, gliding. Nothing is final before ds:drop:
 * the page saves there, and its preventDefault() refuses the move.
 *
 * Events (bubbling, on the container, also through on(type, fn)):
 *   ds:drag-start  { item, from, mode }  cancelable: refuses the lift
 *   ds:drag-move   { item, from, to, mode }
 *   ds:drop        { item, from, to, mode }  cancelable: back to `from`
 *   ds:drag-cancel { item, from, mode }
 * `from` and `to` are targets: { zone, index } (the index among the zone's
 * items without the dragged one). A drop on the place it came from is a
 * ds:drag-cancel without an announcement of its own beyond "Dropped".
 *
 * Other shapes of drop: `target(point, ctx)` (a pointer position to a target,
 * or null: none) and `keyTarget(key, ctx)` (a key to a target) replace the
 * list logic, and `place(target, ctx)` replaces the move in the DOM: a tree
 * returns { zone, index, position: 'inside' } and marks the row, a panel grid
 * returns its cell and shows a placeholder. Two targets are the same when their
 * zone, index and position are. Zones may nest; an item never goes into a zone
 * inside itself: the context's `zones` leave those out, and a target that names
 * one is ignored.
 *
 * What it writes on elements (data-ds-dragging, data-ds-dragover,
 * aria-describedby, translate, z-index) is owned state, so a morph during a
 * drag leaves it alone. Still hold live re-renders of the list until ds:drop or
 * ds:drag-cancel: a re-render that reorders moves the item under the pointer.
 *
 * ES2022; no DOM is touched until create() runs.
 *
 * Progressive:
 * - moveBefore (the moved item keeps its running animations and the focus):
 *   without it insertBefore, and the focus is put back on the handle.
 */

import { emit, runtime, t } from './core.js';
import { flip, motionDuration, motionEasing, travelDuration } from './motion.js';

/** How far a press moves before it is a drag, in px. */
const DRAG_THRESHOLD = 4;

/** The band along a scroller's edge that scrolls it, and the fastest it goes, px per frame. */
const SCROLL_EDGE = 48;
const SCROLL_SPEED = 16;

/** How many characters of an item's text name it, when nothing else does. */
const LABEL_LENGTH = 60;

/** What the page has to interact with inside a handle-less item: a press there is no drag. */
const INTERACTIVE = 'a[href], button, input, select, textarea, label, [contenteditable]:not([contenteditable="false"])';

/** Keys that move a lifted item. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * This module's shared state: the live region and the hint of each host, and
 * the numbering of the hints' ids.
 * @type {{ regions: WeakMap<Element, HTMLElement>, hints: WeakMap<Element, HTMLElement>, count: number }}
 */
const shared = runtime.state('dnd', () => ({
  regions: new WeakMap(),
  hints: new WeakMap(),
  count: 0,
}));

/** The owned-state record of dom.js (shared by every copy): a morph leaves these names alone. */
const OWNED = Symbol.for('ds.owned');

function own(element, kind, name) {
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record[kind].set(name, (record[kind].get(name) ?? 0) + 1);
}

function disown(element, kind, name) {
  const map = element[OWNED]?.[kind];
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

/** The modal around `node`, else its theme: what stays reachable while a modal traps the page. */
const speechHost = (node) => node.closest?.('dialog, .ds-dialog, .ds-sheet') ?? node.closest?.('.ds-theme') ?? node.ownerDocument?.body;

/**
 * The polite live region of `node`'s host, made once. Its own, as sortable()'s:
 * DS.a11y.announce() is the snackbar region's, and a page that drags would pull
 * in the toast part for one line of speech.
 */
function regionOf(node) {
  const host = speechHost(node);
  if (!host) return null;
  let region = shared.regions.get(host);
  if (!region?.isConnected) {
    region = node.ownerDocument.createElement('div');
    region.className = 'ds-sr';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('data-ds-keep', '');
    host.append(region);
    shared.regions.set(host, region);
  }
  return region;
}

/** Says `text` politely; the region empties first, so the same text twice is still news. */
function speak(node, text) {
  const region = text ? regionOf(node) : null;
  if (!region) return;
  region.textContent = '';
  setTimeout(() => {
    region.textContent = text;
  });
}

/** The id of the hint of `node`'s host: hidden text that a handle's aria-describedby names. */
function hintId(node) {
  const host = speechHost(node);
  if (!host) return '';
  let hint = shared.hints.get(host);
  if (!hint?.isConnected) {
    hint = node.ownerDocument.createElement('div');
    shared.count += 1;
    hint.id = `ds-dnd-hint-${shared.count}`;
    hint.hidden = true;
    hint.setAttribute('data-ds-keep', '');
    host.append(hint);
    shared.hints.set(host, hint);
  }
  hint.textContent = t('dragHint');
  return hint.id;
}

/**
 * Where an element sits without its translate or a running glide, in client
 * coordinates: offsetTop ignores transforms, so a neighbour that glides aside
 * counts where it is going. The scroll of what lies between it and its
 * offsetParent has to come off by hand.
 */
function layoutBox(element) {
  const parent = element.offsetParent;
  const width = element.offsetWidth ?? 0;
  const height = element.offsetHeight ?? 0;
  if (!parent) {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.left + width, bottom: rect.top + height, width, height };
  }
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  let left;
  let top;
  if (parent === doc.body && view.getComputedStyle(parent).position === 'static') {
    // A static body is no real origin: the offsets count from the document's, its margin included.
    const own = parent === doc.scrollingElement ? 0 : 1;
    left = element.offsetLeft - view.scrollX - own * parent.scrollLeft;
    top = element.offsetTop - view.scrollY - own * parent.scrollTop;
  } else {
    const rect = parent.getBoundingClientRect();
    left = rect.left + parent.clientLeft - parent.scrollLeft + element.offsetLeft;
    top = rect.top + parent.clientTop - parent.scrollTop + element.offsetTop;
  }
  for (let at = element.parentElement; at && at !== parent; at = at.parentElement) {
    left -= at.scrollLeft;
    top -= at.scrollTop;
  }
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const scrollerOverflow = /auto|scroll|overlay/;

/**
 * The ancestors of `item` that can scroll, nearest first, ending with the
 * document's scroller, each with how far it goes. Read without the item's
 * translate: it counts as overflow, so a scroller following the item would
 * make room for it for ever.
 */
function scrollers(item) {
  const found = [];
  const doc = item.ownerDocument;
  const translate = item.style.translate;
  item.style.removeProperty('translate');
  const limits = (element) => ({ element, maxTop: element.scrollHeight - element.clientHeight, maxLeft: element.scrollWidth - element.clientWidth });
  for (let at = item.parentElement; at && at !== doc.documentElement; at = at.parentElement) {
    const style = doc.defaultView.getComputedStyle(at);
    if ((scrollerOverflow.test(style.overflowY) && at.scrollHeight > at.clientHeight) || (scrollerOverflow.test(style.overflowX) && at.scrollWidth > at.clientWidth)) found.push(limits(at));
  }
  if (doc.scrollingElement) found.push(limits(doc.scrollingElement));
  item.style.translate = translate;
  return found;
}

const sameTarget = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.zone === b.zone && a.index === b.index && a.position === b.position);

/** The live instance of each container. @type {WeakMap<Element, any>} */
const instances = new WeakMap();

/**
 * Moves items by pointer and keyboard inside `container` (see the header);
 * once per container. `items`: a selector (default the zone's element
 * children). `handle`: where a drag starts (default '.ds-grip'). `zones`: a
 * selector of the drop zones in the container (default the container). `list`:
 * the element in a zone that holds its items (default the zone). `axis`: how a
 * zone's items run, 'block' (default), 'inline' or 'both' (wrapping).
 * `accept(item, zone)`: whether the item may go there. `label(item)` and
 * `zoneLabel(zone)` name them in announcements (default the aria-label, else
 * the text). `announce(type, detail)` returns the text for 'grab', 'move',
 * 'drop' or 'cancel' ('' stays silent), default the strings dragGrabbed ...
 * of DS.core.config(). `target`, `keyTarget` and `place` replace the list logic.
 * `autoScroll` (default true). get() is the running drag or null; set({ item,
 * zone, index }) moves an item without a drag, with the events and the
 * announcement of a drop (the DOM is in its new order when ds:drop runs, and
 * back if it is refused); cancel() ends a running drag; on(type, fn) for
 * 'drag-start', 'drag-move', 'drop', 'drag-cancel'.
 * @param {Element|null|undefined} container
 * @param {{ items?: string, handle?: string, zones?: string, list?: string, axis?: 'block'|'inline'|'both', accept?: (item: Element, zone: Element) => boolean, label?: (item: Element) => string, zoneLabel?: (zone: Element) => string, announce?: (type: 'grab'|'move'|'drop'|'cancel', detail: object) => string, target?: (point: { x: number, y: number }, context: object) => object|null, keyTarget?: (key: string, context: object) => object|null, place?: (target: object, context: object) => void, autoScroll?: boolean }} [options]
 * @returns {{ get: () => object|null, set: (value: { item: Element, zone?: Element, index: number }) => boolean, cancel: () => void, on: (type: string, fn: (detail: any) => void) => () => void, destroy: () => void }}
 */
export function create(container, options = {}) {
  if (!container?.ownerDocument) return { get: () => null, set: () => false, cancel() {}, on: () => () => {}, destroy() {} };
  const existing = instances.get(container);
  if (existing) return existing;

  const doc = container.ownerDocument;
  const view = doc.defaultView;
  const handleSelector = options.handle ?? '.ds-grip';
  const selector = options.items;
  const axis = options.axis ?? 'block';
  const autoScroll = options.autoScroll !== false;

  const allZones = () => {
    if (!options.zones) return [container];
    const found = Array.from(container.querySelectorAll(options.zones));
    return container.matches(options.zones) ? [container, ...found] : found;
  };
  const severalZones = () => Boolean(options.zones) && allZones().length > 1;
  /** The zones `item` can go to: a zone inside it would move with it, and the DOM refuses that. */
  const zonesFor = (item) => allZones().filter((zone) => !item.contains(zone));
  const accepts = (item, zone) => (options.accept ? options.accept(item, zone) !== false : true);
  const zoneOf = (node) => {
    const zones = options.zones;
    if (!zones) return container;
    const zone = node.parentElement?.closest(zones);
    return zone && container.contains(zone) ? zone : null;
  };
  const listOf = (zone) => (options.list ? zone.querySelector(options.list) ?? zone : zone);
  /** A zone's items in order: its own (not those of a zone nested in it), without pending removals. */
  const itemsIn = (zone) => {
    const list = selector ? Array.from(zone.querySelectorAll(selector)) : Array.from(listOf(zone).children);
    return list.filter((item) => !item.hasAttribute('data-ds-keep') && !item.hasAttribute('data-ds-leaving') && !item.hidden && zoneOf(item) === zone);
  };
  const itemOf = (node) => {
    const zones = allZones();
    for (let at = node; at && at !== container.parentElement; at = at.parentElement) {
      const zone = zoneOf(at);
      if (zone && zones.includes(zone) && (selector ? at.matches(selector) : at.parentElement === listOf(zone))) return at;
    }
    return null;
  };
  const blocked = (handle, item) => [handle, item].some((node) => node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('aria-busy') === 'true');

  const labelOf = (item) => {
    if (options.label) return String(options.label(item) ?? '');
    const text = (item.getAttribute('aria-label') ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH)}…` : text;
  };
  const zoneLabelOf = (zone) => {
    if (!zone) return '';
    if (options.zoneLabel) return String(options.zoneLabel(zone) ?? '');
    const named = zone.getAttribute('aria-labelledby');
    return (zone.getAttribute('aria-label') ?? (named ? doc.getElementById(named)?.textContent : '') ?? '').replace(/\s+/g, ' ').trim();
  };
  /** Tells what happened, in the page's words or the system's strings. */
  const say = (type, item, target) => {
    const zone = target?.zone ?? null;
    const others = zone ? itemsIn(zone).filter((other) => other !== item) : [];
    const detail = {
      item,
      zone,
      label: labelOf(item),
      zoneName: severalZones() ? zoneLabelOf(zone) : '',
      position: (target?.index ?? 0) + 1,
      total: others.length + 1,
    };
    const key = { grab: 'dragGrabbed', move: detail.zoneName ? 'dragMovedZone' : 'dragMoved', drop: detail.zoneName ? 'dragDroppedZone' : 'dragDropped', cancel: 'dragCancelled' }[type];
    const text = options.announce ? options.announce(type, detail) : t(key, { label: detail.label, zone: detail.zoneName, position: detail.position, total: detail.total });
    speak(container, text);
  };

  /** Where `item` is now, as a target. */
  const whereIs = (item) => {
    const zone = zoneOf(item);
    return { zone, index: zone ? Math.max(0, itemsIn(zone).indexOf(item)) : 0 };
  };

  /** Puts `item` at `index` among the others of `zone`, keeping the focus inside it. */
  const put = (item, zone, index) => {
    const others = itemsIn(zone).filter((other) => other !== item);
    const anchor = others[index] ?? null;
    const parent = anchor?.parentNode ?? others.at(-1)?.parentNode ?? listOf(zone);
    const reference = anchor ?? others.at(-1)?.nextSibling ?? null;
    const focused = item.getRootNode().activeElement;
    const keep = focused && item.contains(focused) ? focused : null;
    const scrolled = [];
    for (let at = parent; at; at = at.parentElement) scrolled.push([at, at.scrollTop, at.scrollLeft]);
    if (typeof parent.moveBefore === 'function') {
      try {
        parent.moveBefore(item, reference);
      } catch {
        parent.insertBefore(item, reference);
      }
    } else parent.insertBefore(item, reference);
    if (keep && item.getRootNode().activeElement !== keep) keep.focus({ preventScroll: true });
    // Chromium's moveBefore() of a focused item scrolls it into view by itself: the drag decides what scrolls.
    for (const [at, top, left] of scrolled) {
      if (at.scrollTop !== top) at.scrollTop = top;
      if (at.scrollLeft !== left) at.scrollLeft = left;
    }
  };

  /** From the place it showed in into its layout place, on the spring. */
  const glideHome = (item, from) => {
    const to = item.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.hypot(dx, dy) < 0.5 || typeof item.animate !== 'function') return;
    const glide = item.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], {
      duration: travelDuration(container, Math.hypot(dx, dy)),
      easing: motionEasing(container, '--ds-ease-spatial'),
    });
    glide.id = 'ds-drag';
  };

  /**
   * The default move in the DOM: the others make room through flip(), one
   * flip per zone it touches. The item itself is left out of them (flip would
   * fade it in as new in the zone it arrives in): under a pointer it follows
   * the pointer, otherwise it glides here.
   */
  const defaultPlace = (target, context) => {
    const { item, mode } = context;
    // What sits inside the dragged item (a nested list) travels with it.
    const others = selector ? `:is(${selector}):not([data-ds-dragging]):not([data-ds-dragging] *)` : ':scope > :not([data-ds-dragging])';
    const marked = !item.hasAttribute('data-ds-dragging');
    if (marked) item.setAttribute('data-ds-dragging', 'end');
    const showing = item.getBoundingClientRect();
    for (const animation of item.getAnimations?.() ?? []) if (animation.id === 'ds-drag') animation.cancel();
    const zones = [...new Set([zoneOf(item), target.zone])].filter(Boolean);
    const run = (at) => {
      if (at === zones.length) put(item, target.zone, target.index);
      else flip(selector ? zones[at] : listOf(zones[at]), () => run(at + 1), { items: others });
    };
    run(0);
    if (marked) item.removeAttribute('data-ds-dragging');
    // In view before the glide measures, so it starts from where the item showed, whatever scrolled.
    if (mode === 'keyboard') item.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    if (mode !== 'pointer') glideHome(item, showing);
  };

  /* ── The running drag ──────────────────────────────── */

  let drag = null;
  let press = null;
  /** Items whose raised look is still leaving after a drop: item → { timer, z }. */
  const ending = new Map();
  /** Handles with the hint on them. */
  const hinted = new Map();
  /** Takes eatClick()'s listeners off; replaced by each drag. */
  let clickGuard = null;
  const letClickGo = () => {
    clickGuard?.();
    clickGuard = null;
  };

  const contextOf = () => ({ item: drag.item, mode: drag.mode, from: drag.from, current: drag.current, zones: zonesFor(drag.item), itemsIn, accepts, layoutBox });

  const setDragover = (zone) => {
    if (drag.over === zone) return;
    if (drag.over) {
      drag.over.removeAttribute('data-ds-dragover');
      disown(drag.over, 'attrs', 'data-ds-dragover');
    }
    drag.over = zone && severalZones() ? zone : null;
    if (drag.over) {
      own(drag.over, 'attrs', 'data-ds-dragover');
      drag.over.setAttribute('data-ds-dragover', '');
    }
  };

  /** Ends a drop's leave at once: the z-index it had before the drag, nothing owned. */
  const finish = (item) => {
    const end = ending.get(item);
    if (!end) return;
    ending.delete(item);
    clearTimeout(end.timer);
    item.removeAttribute('data-ds-dragging');
    item.style.zIndex = end.z;
    if (!item.style.length) item.removeAttribute('style');
    disown(item, 'attrs', 'data-ds-dragging');
    for (const name of ['translate', 'z-index']) disown(item, 'props', name);
  };

  /**
   * Moving the item without moveBefore() costs the handle its pointer capture:
   * it takes it back, so the drag goes on outside the container too. False when
   * the handle is gone.
   */
  const keepCapture = () => {
    if (!drag || drag.pointer === null) return true;
    try {
      if (!drag.handle.hasPointerCapture?.(drag.pointer)) drag.handle.setPointerCapture?.(drag.pointer);
      return true;
    } catch {
      return false;
    }
  };

  /** Moves the dragged item to `target`, if that is news. */
  const moveTo = (target) => {
    if (!target || sameTarget(target, drag.current)) return false;
    if (target.zone && (drag.item.contains(target.zone) || !accepts(drag.item, target.zone))) return false;
    const zoneBefore = drag.current.zone;
    drag.moving = true;
    try {
      (options.place ?? defaultPlace)(target, contextOf());
    } finally {
      drag.moving = false;
    }
    drag.current = target;
    keepCapture();
    setDragover(target.zone);
    say('move', drag.item, target);
    emit(container, 'drag-move', { item: drag.item, from: drag.from, to: target, mode: drag.mode });
    if (autoScroll && drag.mode === 'pointer' && target.zone !== zoneBefore) drag.scrollers = scrollers(drag.item);
    return true;
  };

  /** Where the box of the dragged item would land in `others`, by the middles it passed. */
  const defaultTarget = (point, context) => {
    const { item, current } = context;
    const zones = context.zones;
    const hit = zones.filter((zone) => {
      const rect = zone.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }).filter((zone) => accepts(item, zone));
    // The innermost zone under the pointer; off every zone it stays where it is.
    const zone = hit.find((candidate) => !hit.some((other) => other !== candidate && candidate.contains(other))) ?? current.zone;
    const others = itemsIn(zone).filter((other) => other !== item);
    const box = { left: point.x - drag.grabX, top: point.y - drag.grabY, width: drag.width, height: drag.height };
    const inline = axis === 'inline';
    const start = inline ? box.left : box.top;
    const end = start + (inline ? box.width : box.height);
    const middle = (other) => {
      const layout = layoutBox(other);
      return inline ? layout.left + layout.width / 2 : layout.top + layout.height / 2;
    };
    if (axis === 'both') {
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const over = others.findIndex((other) => {
        const layout = layoutBox(other);
        return cx >= layout.left && cx <= layout.right && cy >= layout.top && cy <= layout.bottom;
      });
      if (over < 0) return zone === current.zone ? current : { zone, index: others.length };
      const index = zone === current.zone && current.index > over ? over : over + (zone === current.zone ? 1 : 0);
      return { zone, index: Math.min(index, others.length) };
    }
    if (zone !== current.zone) {
      // New in this zone: in front of the first one the box's middle has not reached.
      const centre = (start + end) / 2;
      const index = others.findIndex((other) => centre < middle(other));
      return { zone, index: index < 0 ? others.length : index };
    }
    let index = Math.min(current.index, others.length);
    // A neighbour gives way once the dragged box's leading edge passes its middle.
    while (index > 0 && start < middle(others[index - 1])) index -= 1;
    while (index < others.length && end > middle(others[index])) index += 1;
    return { zone, index };
  };

  /** Keeps the item under the pointer, wherever the layout has it now. */
  const follow = () => {
    const { item } = drag;
    const layout = layoutBox(item);
    const constrained = axis !== 'both' && !severalZones() && !options.target;
    const dx = drag.x - drag.grabX - layout.left;
    const dy = drag.y - drag.grabY - layout.top;
    const x = constrained && axis === 'block' ? 0 : dx;
    const y = constrained && axis === 'inline' ? 0 : dy;
    item.style.translate = `${Math.round(x * 10) / 10}px ${Math.round(y * 10) / 10}px`;
  };

  const track = () => {
    const target = (options.target ?? defaultTarget)({ x: drag.x, y: drag.y }, contextOf());
    moveTo(target);
    follow();
  };

  /** Scrolls the nearest ancestor with the pointer in an edge band, every frame of a drag. */
  const scrollFrame = () => {
    if (!drag || drag.mode !== 'pointer') return;
    drag.frame = view.requestAnimationFrame(scrollFrame);
    for (const { element: scroller, maxTop, maxLeft } of drag.scrollers) {
      const page = scroller === doc.scrollingElement;
      const rect = page ? { top: 0, left: 0, bottom: view.innerHeight, right: view.innerWidth } : scroller.getBoundingClientRect();
      const step = (near, far) => {
        if (near < SCROLL_EDGE) return -SCROLL_SPEED * (1 - Math.max(0, near) / SCROLL_EDGE);
        if (far < SCROLL_EDGE) return SCROLL_SPEED * (1 - Math.max(0, far) / SCROLL_EDGE);
        return 0;
      };
      const dy = step(drag.y - rect.top, rect.bottom - drag.y);
      const dx = step(drag.x - rect.left, rect.right - drag.x);
      const beforeTop = scroller.scrollTop;
      const beforeLeft = scroller.scrollLeft;
      if (dy) scroller.scrollTop = Math.min(maxTop, beforeTop + dy);
      if (dx) scroller.scrollLeft = Math.min(maxLeft, beforeLeft + dx);
      if (scroller.scrollTop !== beforeTop || scroller.scrollLeft !== beforeLeft) {
        track();
        return;
      }
    }
  };

  /** Keys while a keyboard drag runs, and Escape during a pointer drag. */
  const onDragKey = (/** @type {KeyboardEvent} */ event) => {
    if (!drag) return;
    if (drag.mode === 'keyboard' && (!drag.handle.isConnected || drag.handle.getRootNode().activeElement !== drag.handle)) {
      // The focus left without a focusout (Firefox and WebKit, when the handle was removed): this key is the page's.
      end(false);
      return;
    }
    if (event.key === 'Escape') {
      // preventDefault(): an open dialog around the list stays open.
      event.preventDefault();
      event.stopPropagation();
      end(false);
      return;
    }
    if (drag.mode !== 'keyboard' || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      // A held key is one press: it lifted, and it does not drop.
      if (!event.repeat) end(true);
      return;
    }
    if (!MOVE_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const context = contextOf();
    const target = (options.keyTarget ?? defaultKeyTarget)(event.key, context);
    // The default place scrolls before its glide; what a page's place() does is its own.
    if (moveTo(target) && options.place) drag.item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  /** The default key moves: one place along the axis, to an end, or to the next zone that accepts it. */
  const defaultKeyTarget = (key, context) => {
    const { item, current } = context;
    const others = itemsIn(current.zone).filter((other) => other !== item);
    if (key === 'Home') return { zone: current.zone, index: 0 };
    if (key === 'End') return { zone: current.zone, index: others.length };
    if (axis === 'both') {
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const index = current.index + (key === 'ArrowLeft' ? -1 : 1);
        if (index >= 0 && index <= others.length) return { zone: current.zone, index };
      } else {
        // Up and down: the place in the row above or below, nearest by its middle.
        const box = layoutBox(item);
        const centre = box.left + box.width / 2;
        let best = null;
        for (const [index, other] of others.entries()) {
          const layout = layoutBox(other);
          if (key === 'ArrowUp' ? layout.bottom > box.top : layout.top < box.bottom) continue;
          const distance = Math.abs(layout.top - box.top) * 1000 + Math.abs(layout.left + layout.width / 2 - centre);
          if (!best || distance < best.distance) best = { index, distance };
        }
        if (best) return { zone: current.zone, index: key === 'ArrowDown' ? Math.min(best.index + 1, others.length) : best.index };
      }
      // Nowhere left in this zone: on to the next, as a pointer can.
    } else {
      const along = axis === 'inline' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (along.includes(key)) return { zone: current.zone, index: clampIndex(current.index + (key === along[0] ? -1 : 1), others.length) };
    }
    const zones = context.zones;
    const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    for (let at = zones.indexOf(current.zone) + step; at >= 0 && at < zones.length; at += step) {
      if (!accepts(item, zones[at])) continue;
      const count = itemsIn(zones[at]).length;
      return { zone: zones[at], index: Math.min(current.index, count) };
    }
    return null;
  };
  const clampIndex = (index, last) => Math.min(Math.max(index, 0), last);

  /** Lifts `item`; false when a listener refused. */
  const lift = (item, handle, mode, fields = {}) => {
    finish(item);
    const from = whereIs(item);
    // Under a pointer the item follows its inline translate, which a glide would hide. Keys: the glide goes on until a move measures it.
    if (mode === 'pointer') for (const animation of item.getAnimations?.() ?? []) if (animation.id === 'ds-drag') animation.cancel();
    if (!emit(container, 'drag-start', { item, from, mode }, { cancelable: true })) return false;
    drag = { item, handle, mode, from, current: from, x: 0, y: 0, grabX: 0, grabY: 0, width: 0, height: 0, pointer: null, over: null, frame: 0, moving: false, z: item.style.zIndex, scrollers: autoScroll && mode === 'pointer' ? scrollers(item) : [], ...fields };
    own(item, 'attrs', 'data-ds-dragging');
    for (const name of ['translate', 'z-index']) own(item, 'props', name);
    item.setAttribute('data-ds-dragging', '');
    const sticky = parseInt(view.getComputedStyle(container).getPropertyValue('--ds-z-sticky'), 10);
    item.style.zIndex = Number.isFinite(sticky) ? String(sticky - 1) : 'calc(var(--ds-z-sticky) - 1)';
    setDragover(from.zone);
    doc.addEventListener('keydown', onDragKey, true);
    // A handle that left the document loses its capture to the document, not to the container.
    doc.addEventListener('lostpointercapture', onLostCapture, true);
    // A focused element that is removed fires no focusout in Firefox and WebKit.
    if (mode === 'keyboard' && typeof view.MutationObserver === 'function') {
      drag.watcher = new view.MutationObserver(() => {
        if (drag?.handle === handle && !handle.isConnected) end(false);
      });
      drag.watcher.observe(container, { childList: true, subtree: true });
    }
    say('grab', item, from);
    if (mode === 'pointer' && autoScroll) drag.frame = view.requestAnimationFrame(scrollFrame);
    return true;
  };

  /**
   * The click the browser adds to the release of a pointer drag is no click: a
   * card that opens on one would open after every drag. The release can still
   * be to come (Escape, a lost capture). A later press lets go at once, and a
   * click of a key or a script (detail 0) never was this one.
   */
  const eatClick = (released) => {
    letClickGo();
    let timer = 0;
    const eat = (/** @type {MouseEvent} */ event) => {
      if (!event.detail) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      letClickGo();
    };
    const arm = () => {
      timer = setTimeout(letClickGo, motionDuration(container, '--ds-dur-fast'));
    };
    doc.addEventListener('click', eat, true);
    doc.addEventListener('pointerdown', letClickGo, true);
    doc.addEventListener('pointercancel', letClickGo, true);
    if (released) arm();
    else doc.addEventListener('pointerup', arm, { capture: true, once: true });
    clickGuard = () => {
      clearTimeout(timer);
      doc.removeEventListener('click', eat, true);
      doc.removeEventListener('pointerdown', letClickGo, true);
      doc.removeEventListener('pointercancel', letClickGo, true);
      doc.removeEventListener('pointerup', arm, true);
    };
  };

  /**
   * Ends the drag: a drop (`commit`) or a cancel. `release`: 'up' when the
   * pointer just came up, 'gone' when it was cancelled; else it may still be down.
   */
  const end = (commit, release) => {
    const ended = drag;
    if (!ended) return;
    drag = null;
    const { item, handle, from, mode, z } = ended;
    if (ended.frame) view.cancelAnimationFrame(ended.frame);
    ended.watcher?.disconnect();
    if (mode === 'pointer' && release !== 'gone') eatClick(release === 'up');
    doc.removeEventListener('keydown', onDragKey, true);
    doc.removeEventListener('lostpointercapture', onLostCapture, true);
    if (ended.pointer !== null) {
      try {
        handle.releasePointerCapture?.(ended.pointer);
      } catch {
        // The pointer is gone already (a pointercancel).
      }
    }
    const visual = item.getBoundingClientRect();
    item.style.removeProperty('translate');
    const changed = !sameTarget(ended.current, from);
    let to = ended.current;
    let dropped = commit;
    if (commit && changed) dropped = emit(container, 'drop', { item, from, to, mode }, { cancelable: true });
    if (ended.over) {
      ended.over.removeAttribute('data-ds-dragover');
      disown(ended.over, 'attrs', 'data-ds-dragover');
    }
    // An item a re-render took stays gone.
    if (!dropped && changed && item.isConnected) {
      (options.place ?? defaultPlace)(from, { item, mode, from, current: ended.current, zones: zonesFor(item), itemsIn, accepts, layoutBox });
      to = from;
    }
    if (!commit || !dropped || !changed) emit(container, 'drag-cancel', { item, from, mode });
    say(commit && dropped ? 'drop' : 'cancel', item, to);
    glideHome(item, visual);
    // The raised look leaves in --ds-dur-instant (drag.css: data-ds-dragging="end").
    item.setAttribute('data-ds-dragging', 'end');
    const timer = setTimeout(() => finish(item), Math.max(motionDuration(item, '--ds-dur-instant'), motionDuration(container, '--ds-dur-medium')));
    ending.set(item, { timer, z });
  };

  /* ── Input ─────────────────────────────────────────── */

  const onPointerDown = (/** @type {PointerEvent} */ event) => {
    if (drag || event.button !== 0) return;
    const handle = event.target?.closest?.(handleSelector);
    if (!handle || !container.contains(handle)) return;
    const item = itemOf(handle);
    if (!item || blocked(handle, item)) return;
    // A button inside a whole-item handle stays a button.
    const inner = event.target.closest(INTERACTIVE);
    if (inner && inner !== handle && handle.contains(inner)) return;
    // No preventDefault(): a press alone stays a click and takes the focus. Text selection and native drags stop below.
    handle.setPointerCapture?.(event.pointerId);
    press = { item, handle, pointer: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (/** @type {PointerEvent} */ event) => {
    if (press && event.pointerId === press.pointer) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
      const { item, handle, pointer, x, y } = press;
      press = null;
      // Before the lift, so a glide still running counts from where it shows.
      const rect = item.getBoundingClientRect();
      if (!lift(item, handle, 'pointer', { pointer, grabX: x - rect.left, grabY: y - rect.top, width: rect.width, height: rect.height })) {
        handle.releasePointerCapture?.(pointer);
        return;
      }
    }
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    track();
  };
  const onPointerUp = (/** @type {PointerEvent} */ event) => {
    if (press && event.pointerId === press.pointer) {
      press.handle.releasePointerCapture?.(press.pointer);
      press = null;
      return;
    }
    if (drag?.pointer === event.pointerId) {
      const up = event.type === 'pointerup';
      end(up, up ? 'up' : 'gone');
    }
  };
  const onPressLost = (/** @type {PointerEvent} */ event) => {
    if (press && event.pointerId === press.pointer) press = null;
  };
  const onLostCapture = (/** @type {PointerEvent} */ event) => {
    // Lost to a move in the DOM: take it back. Lost for good (a re-render took the handle): cancel.
    if (drag?.pointer === event.pointerId && !drag.moving && !keepCapture()) end(false);
  };
  const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
    if (drag || event.defaultPrevented || (event.key !== ' ' && event.key !== 'Enter') || event.altKey || event.ctrlKey || event.metaKey) return;
    const handle = event.target?.closest?.(handleSelector);
    if (!handle || !container.contains(handle) || event.target !== handle) return;
    const item = itemOf(handle);
    if (!item || blocked(handle, item)) return;
    if (event.repeat) {
      // The key held after a drop: it neither lifts again nor clicks.
      event.preventDefault();
      return;
    }
    if (lift(item, handle, 'keyboard')) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onFocusIn = (/** @type {FocusEvent} */ event) => {
    const handle = event.target?.closest?.(handleSelector);
    if (!handle || !container.contains(handle) || hinted.has(handle)) return;
    regionOf(container);
    const id = hintId(handle);
    if (!id) return;
    const before = handle.getAttribute('aria-describedby');
    hinted.set(handle, before);
    own(handle, 'attrs', 'aria-describedby');
    handle.setAttribute('aria-describedby', before ? `${before} ${id}` : id);
  };
  const dropHint = (handle) => {
    if (!hinted.has(handle)) return;
    const before = hinted.get(handle);
    hinted.delete(handle);
    if (before) handle.setAttribute('aria-describedby', before);
    else handle.removeAttribute('aria-describedby');
    disown(handle, 'attrs', 'aria-describedby');
  };
  const onFocusOut = (/** @type {FocusEvent} */ event) => {
    const handle = event.target?.closest?.(handleSelector);
    if (handle) dropHint(handle);
    // A focus that leaves ends a keyboard drag: nothing moved without being asked.
    if (drag?.mode === 'keyboard' && !drag.moving && event.target === drag.handle) end(false);
  };
  const onNative = (/** @type {Event} */ event) => {
    if (drag || press) event.preventDefault();
  };

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);
  container.addEventListener('lostpointercapture', onPressLost);
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('focusin', onFocusIn);
  container.addEventListener('focusout', onFocusOut);
  container.addEventListener('dragstart', onNative);
  container.addEventListener('selectstart', onNative);

  const controller = {
    get() {
      return drag ? { item: drag.item, mode: drag.mode, from: drag.from, to: drag.current } : null;
    },
    set(value) {
      const item = value?.item;
      if (!item || drag) return false;
      const from = whereIs(item);
      const zone = value.zone ?? from.zone;
      if (!zone || item.contains(zone) || !accepts(item, zone)) return false;
      const others = itemsIn(zone).filter((other) => other !== item);
      const target = { zone, index: clampIndex(value.index ?? from.index, others.length) };
      if (sameTarget(target, from)) return false;
      const context = { item, mode: 'api', from, current: from, zones: zonesFor(item), itemsIn, accepts, layoutBox };
      // As a drop: the DOM is in its new order when ds:drop runs, and back if it is refused.
      (options.place ?? defaultPlace)(target, context);
      if (!emit(container, 'drop', { item, from, to: target, mode: 'api' }, { cancelable: true })) {
        (options.place ?? defaultPlace)(from, { ...context, current: target });
        return false;
      }
      say('drop', item, target);
      return true;
    },
    cancel() {
      end(false);
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === container) fn(event.detail);
      };
      container.addEventListener(`ds:${type}`, listener);
      return () => container.removeEventListener(`ds:${type}`, listener);
    },
    destroy() {
      if (instances.get(container) !== controller) return;
      end(false);
      press = null;
      for (const item of [...ending.keys()]) finish(item);
      for (const handle of [...hinted.keys()]) dropHint(handle);
      instances.delete(container);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('lostpointercapture', onPressLost);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      container.removeEventListener('dragstart', onNative);
      container.removeEventListener('selectstart', onNative);
    },
  };
  instances.set(container, controller);
  // Before the first words: pressing Space on a handle is too late for a reader to know the region.
  if (container.isConnected) regionOf(container);
  return controller;
}
