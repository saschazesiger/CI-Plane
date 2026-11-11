/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Citations (DS.cite): a numbered marker that opens the card of its source,
 * on hover like a hover card and on a press like a disclosure.
 *
 *   <button class="ds-cite" type="button" aria-controls="src-1-card" aria-label="Source 1: Warranty register" data-ds-cite>1</button>
 *   <div class="ds-cite__card" id="src-1-card" popover="manual" hidden> ... </div>
 *   const marker = DS.cite.create(button);
 *   marker.set(true);                                  // opens its card, pinned
 *
 * The card is the element aria-controls names (several markers may share
 * one). It is a popup of DS.overlay (the stack, Escape, aria-expanded on
 * the marker, the entrance from the marker), in the top layer
 * (popover="manual", written when missing), placed by DS.position.place()
 * under the marker, above it without room (--ds-cite-x, --ds-cite-y), and
 * placed again on scroll and resize while it is open.
 *
 * Pointer: resting on the marker for --ds-delay-tooltip opens the card; it
 * stays while the pointer is on the marker or the card, and closes
 * --ds-delay-tooltip-hide after it left both (so the pointer can cross to
 * the card, WCAG 1.4.13). A press opens it pinned: it stays until a press
 * outside, Escape, or another press on the marker. Keyboard: Enter or
 * Space opens it pinned and moves focus into it (its first link); Escape
 * closes it and focus returns to the marker; Tab from inside closes it and
 * goes on from the marker (Shift+Tab lands on the marker). Touch: a tap is
 * a press. Nothing opens on focus alone: the marker's name says the source.
 *
 * The controller: get() (open), set(open) (pinned when true),
 * on('change', fn) (with { open }), destroy(); ds:change with { open } on
 * the marker when its card opens or closes.
 *
 * ES2022. No Progressive: features (popover and the overlay stack are at
 * the floor).
 */
import { define, emit, runtime } from './core.js';
import { motionDuration } from './motion.js';
import { close, open } from './overlay.js';
import { place, pxOf } from './position.js';
import { tabbables } from './a11y.js';

/** Per page: the cards open now, with their marker and whether they are pinned. */
const shared = runtime.state('cite', () => ({ open: new Map() }));

/**
 * The card a marker opens: the element its aria-controls names, in its
 * document or shadow root; null without one.
 * @param {Element|null|undefined} marker
 * @returns {HTMLElement|null}
 */
export function cardOf(marker) {
  const id = marker?.getAttribute?.('aria-controls')?.trim();
  if (!id) return null;
  const root = marker.getRootNode?.() ?? marker.ownerDocument;
  return /** @type {HTMLElement|null} */ (root?.getElementById?.(id) ?? marker.ownerDocument?.getElementById(id) ?? null);
}

const viewOf = (node) => node.ownerDocument?.defaultView ?? globalThis;

/** Places a card under (or above) its marker. */
function placeCard(card, marker) {
  const gap = pxOf(card, '--ds-space-1', 4);
  place(card, marker, { offset: gap, padding: pxOf(card, '--ds-space-2', 8), crossFlip: true, x: '--ds-cite-x', y: '--ds-cite-y' });
}

/** Out of the top layer once DS.overlay hid it. */
function release(card) {
  try {
    if (card.matches(':popover-open')) card.hidePopover();
  } catch {
    // Not open.
  }
}

/**
 * The cards whose pointer and keys are bound: once per card, for every
 * marker, with the controllers that use it; the last one to go unbinds it.
 * @type {WeakMap<Element, { users: Set<object>, unbind: AbortController }>}
 */
const bound = new WeakMap();

/** Closes a card that only the pointer opened, after the hide grace, unless the pointer came back. */
function scheduleClose(card, held) {
  const view = viewOf(card);
  view.clearTimeout(held.timer);
  if (held.pinned) return;
  held.timer = view.setTimeout(() => {
    if (shared.open.get(card) === held && !held.pinned) close(card, { reason: 'pointer' });
  }, motionDuration(card, '--ds-delay-tooltip-hide'));
}

const hovering = (event) => event.pointerType === 'mouse' || event.pointerType === 'pen';

/** Lets a controller go from a card; the card's listeners go with the last one. */
function unbindCard(card, user) {
  const entry = bound.get(card);
  if (!entry || !entry.users.delete(user) || entry.users.size) return;
  entry.unbind.abort();
  bound.delete(card);
}

/** The card's own pointer and keys, bound for `user` (a controller). */
function bindCard(card, user) {
  if (!card) return;
  const entry = bound.get(card);
  if (entry) {
    entry.users.add(user);
    return;
  }
  const unbind = new AbortController();
  const { signal } = unbind;
  bound.set(card, { users: new Set([user]), unbind });
  card.addEventListener('pointerenter', () => {
    const held = shared.open.get(card);
    if (held) viewOf(card).clearTimeout(held.timer);
  }, { signal });
  card.addEventListener('pointerleave', (event) => {
    const held = shared.open.get(card);
    if (!held || !hovering(event)) return;
    const to = /** @type {Node|null} */ (event.relatedTarget);
    if (to && held.marker.contains(to)) return;
    scheduleClose(card, held);
  }, { signal });
  // Tab past the card's ends goes back to the marker (Shift+Tab lands on
  // it, Tab moves on from it) and closes the card.
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const held = shared.open.get(card);
    if (!held) return;
    const items = tabbables(card);
    if (items.length && event.target !== (event.shiftKey ? items[0] : items.at(-1))) return;
    held.marker.focus();
    if (event.shiftKey) event.preventDefault();
    close(card, { reason: 'tab' });
  }, { signal });
}

function controller(marker, given) {
  // Without the signal of DS.init() (create()), destroy() ends its own.
  const own = given ? null : new AbortController();
  const signal = given ?? own.signal;
  const listeners = new Set();
  const view = viewOf(marker);
  const me = {};
  /** The cards this marker bound, let go on destroy(). */
  const cards = new Set();
  let timer = 0;

  const use = (card) => {
    if (!card || signal.aborted) return;
    cards.add(card);
    bindCard(card, me);
  };

  if (!marker.hasAttribute('aria-expanded')) marker.setAttribute('aria-expanded', 'false');
  use(cardOf(marker));

  /** The open entry of this marker's card, when this marker opened it. */
  const entry = () => {
    const card = cardOf(marker);
    const held = card ? shared.open.get(card) : null;
    return held && held.marker === marker ? held : null;
  };

  const tell = (value) => {
    if (signal.aborted) return;
    emit(marker, 'change', { open: value });
    listeners.forEach((fn) => fn({ open: value }));
  };

  const hide = () => {
    view.clearTimeout(timer);
    const card = cardOf(marker);
    return card && entry() ? close(card, { reason: 'api' }) : Promise.resolve();
  };

  const show = async (pinned, focusIn) => {
    view.clearTimeout(timer);
    const card = cardOf(marker);
    if (!card || signal.aborted) return;
    use(card);
    const held = shared.open.get(card);
    if (held && held.marker === marker) {
      view.clearTimeout(held.timer);
      held.pinned = held.pinned || pinned;
      if (focusIn) tabbables(card)[0]?.focus();
      return;
    }
    // Shared with another marker: its card closes there first.
    if (held) await close(card, { reason: 'api' });
    if (!card.hasAttribute('popover')) card.setAttribute('popover', 'manual');
    card.hidden = false;
    card.setAttribute('data-state', 'closed');
    try {
      if (!card.matches(':popover-open')) card.showPopover();
    } catch {
      // Not a popover any more (the page removed the attribute): it opens in place.
    }
    placeCard(card, marker);
    const follow = new AbortController();
    const mine = { marker, pinned, timer: 0, follow };
    shared.open.set(card, mine);
    const opened = open(card, { opener: marker });
    // Placed again while the page moves under it.
    const again = () => placeCard(card, marker);
    view.addEventListener('scroll', again, { capture: true, passive: true, signal: follow.signal });
    view.addEventListener('resize', again, { passive: true, signal: follow.signal });
    card.addEventListener('ds:close', () => {
      if (shared.open.get(card) === mine) shared.open.delete(card);
      view.clearTimeout(mine.timer);
      follow.abort();
      // Once its exit settled, it leaves the top layer.
      close(card).then(() => {
        if (!shared.open.has(card)) release(card);
      });
      tell(false);
    }, { once: true, signal: follow.signal });
    tell(true);
    await opened;
    if (focusIn && shared.open.get(card) === mine) tabbables(card)[0]?.focus();
  };

  // Hover: resting opens after --ds-delay-tooltip; leaving marker and card closes after the grace.
  marker.addEventListener('pointerenter', (event) => {
    if (!hovering(event)) return;
    const held = entry();
    if (held) {
      view.clearTimeout(held.timer);
      return;
    }
    view.clearTimeout(timer);
    timer = view.setTimeout(() => show(false, false), motionDuration(marker, '--ds-delay-tooltip'));
  }, { signal });
  marker.addEventListener('pointerleave', (event) => {
    if (!hovering(event)) return;
    view.clearTimeout(timer);
    const held = entry();
    const to = /** @type {Node|null} */ (event.relatedTarget);
    if (!held || (to && cardOf(marker)?.contains(to))) return;
    scheduleClose(/** @type {HTMLElement} */ (cardOf(marker)), held);
  }, { signal });

  // A press (Enter and Space press it too) pins it; a press on a pinned one closes it.
  marker.addEventListener('click', (event) => {
    const held = entry();
    if (held?.pinned) {
      hide();
      return;
    }
    show(true, event.detail === 0);
  }, { signal });

  return {
    get: () => Boolean(entry()),
    set(value) {
      if (value) show(true, false);
      else hide();
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      view.clearTimeout(timer);
      listeners.clear();
      if (entry()) hide();
      own?.abort();
      for (const card of cards) unbindCard(card, me);
      cards.clear();
    },
  };
}

define('cite', {
  attribute: 'data-ds-cite',
  init(el, ctx) {
    const handle = controller(el, ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
  // A press outside an open card and its marker closes it.
  global(root) {
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    if (!doc) return () => {};
    const press = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
      for (const [card, held] of [...shared.open]) {
        if (path.includes(card) || path.includes(held.marker)) continue;
        close(card, { reason: 'outside' });
      }
    };
    root.addEventListener('pointerdown', press, true);
    return () => root.removeEventListener('pointerdown', press, true);
  },
});

/**
 * A citation marker driven from the page; the same controller the
 * attribute path makes. destroy() removes every listener it added (the
 * card's with the last marker that uses it).
 * @param {Element} marker
 */
export function create(marker) {
  return controller(marker);
}
