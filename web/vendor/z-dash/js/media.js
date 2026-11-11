/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Media grid (DS.media): a gallery of .ds-media cards as one tab stop, with
 * the selection of a file manager.
 *
 *   <ul class="ds-media-grid" aria-label="Photos" data-ds-media> <li class="ds-media" data-ds-key="p1"> ... </li> ... </ul>
 *   const photos = DS.media.create(grid);
 *   photos.set(['p1', 'p4']);  photos.get();  // ['p1', 'p4']
 *   photos.on('change', ({ selected }) => { ... });   // also ds:change on the grid
 *
 * Keyboard (the grid pattern of the WAI-ARIA practices, for cards):
 * - the grid is one tab stop, the open control of the current card
 *   (DS.a11y.roving, orientation both); Tab then reaches that card's
 *   checkbox and actions, and leaves the grid; the other cards' checkboxes
 *   and actions are out of the tab order (owned tabindex="-1") until their
 *   card is current;
 * - the arrows move between cards (Up and Down to the nearest card of the
 *   row above or below), Home and End to the first and last;
 * - Enter opens (the link or button itself); Space on a card's open
 *   control selects it or lets go, Shift+Space selects the range from the
 *   last card chosen; Shift+click on a checkbox does the same;
 * - Ctrl+A (Cmd+A) selects every card, Escape lets go of all of them (and
 *   is taken, so a dialog around the grid stays open; inside an open menu
 *   or popup of a card it is left to that).
 *
 * The checkboxes are the truth: the stylesheet shows a selected card by
 * :checked, a re-render keeps their state as the page writes it. The
 * controller sets them without firing their own change event and sends one
 * ds:change ({ selected: keys }) per action on the grid; a card's key is
 * its data-ds-key, else its checkbox's value, else its index. A change made
 * from the keyboard, a range, all and none are announced ("4 selected",
 * mediaSelected, mediaSelectionCleared); a plain checkbox speaks for itself.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { announce, roving } from './a11y.js';
import { own, disown } from './dom.js';

const CARD = '.ds-media';
const OPEN = '.ds-media__open';
const CHECK = '.ds-media__check';
/** What a card holds besides its open control that takes focus. */
const SECONDARY = '.ds-media__check, .ds-media__actions :is(a[href], button, input, select, textarea, [tabindex])';
/** Where Escape and the keys belong to someone else. */
const POPUP = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [popover]';

/**
 * The items from `from` to `to` in the order of `items`, both included,
 * whichever comes first; `to` alone when `from` is not in the list.
 * @template T
 * @param {T[]} items
 * @param {T} from
 * @param {T} to
 * @returns {T[]}
 */
export function between(items, from, to) {
  const end = items.indexOf(to);
  if (end < 0) return [];
  const start = items.indexOf(from);
  if (start < 0) return [to];
  return items.slice(Math.min(start, end), Math.max(start, end) + 1);
}

function mediaController(el, signal) {
  const doc = el.ownerDocument;
  const listeners = new Set();
  const abort = new AbortController();
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const on = { signal: abort.signal };
  /** @type {Element|null} the last card chosen, where a range starts */
  let anchor = null;
  /** The change event after a Shift+click that already told. */
  let told = null;
  /** @type {Set<Element>} what this controller took out of the tab order */
  const parked = new Set();

  /** The cards of this grid: its children, or in its list items. */
  const cards = () => [...el.querySelectorAll(CARD)].filter((card) => card.parentElement === el || card.parentElement?.parentElement === el);
  const checkOf = (card) => card.querySelector(CHECK);
  const keyOf = (card, index) => {
    const check = checkOf(card);
    return card.getAttribute('data-ds-key') || (check && check.value && check.value !== 'on' ? check.value : String(index));
  };
  const selected = () => cards().flatMap((card, index) => (checkOf(card)?.checked ? [keyOf(card, index)] : []));

  const rove = roving(el, { items: OPEN, orientation: 'both', activate: false, wrap: false });

  /** Only the current card's checkbox and actions are tab stops. */
  const park = () => {
    const current = cards().find((card) => card.querySelector(`${OPEN}[tabindex="0"]`)) ?? null;
    for (const card of cards()) {
      for (const node of card.querySelectorAll(SECONDARY)) {
        if (node.closest(POPUP)) continue;
        if (card === current) {
          if (parked.has(node)) {
            parked.delete(node);
            disown(node, 'attrs', 'tabindex');
            node.removeAttribute('tabindex');
          }
        } else if (!parked.has(node) && !node.hasAttribute('tabindex')) {
          parked.add(node);
          own(node, 'attrs', 'tabindex');
          node.setAttribute('tabindex', '-1');
        }
      }
    }
    for (const node of parked) {
      if (!el.contains(node)) parked.delete(node);
    }
  };

  const tell = (speak) => {
    const keys = selected();
    if (speak) announce(keys.length ? t('mediaSelected', { count: keys.length }) : t('mediaSelectionCleared'));
    if (signal?.aborted || abort.signal.aborted) return;
    const detail = { selected: keys };
    emit(el, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  };

  /** Sets the checkboxes of `list` to `value`; true when one changed. */
  const write = (list, value) => {
    let changed = false;
    for (const card of list) {
      const check = checkOf(card);
      if (!check || check.disabled || check.checked === value) continue;
      check.checked = value;
      changed = true;
    }
    return changed;
  };

  const toggle = (card, range) => {
    const check = checkOf(card);
    if (!check || check.disabled) return;
    const value = !check.checked;
    const list = range && anchor ? between(cards(), anchor, card) : [card];
    anchor = card;
    if (write(list, value)) tell(true);
  };

  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    if (event.defaultPrevented || !target?.closest || target.closest(POPUP)) return;
    const card = target.closest(CARD);
    if (event.key === ' ' && !event.altKey && !event.ctrlKey && !event.metaKey && card && target.matches(OPEN)) {
      event.preventDefault();
      toggle(card, event.shiftKey);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a' && !target.matches('input:not([type="checkbox"]), textarea, [contenteditable]')) {
      event.preventDefault();
      if (write(cards(), true)) tell(true);
      return;
    }
    if (event.key === 'Escape' && selected().length) {
      event.preventDefault();
      anchor = null;
      if (write(cards(), false)) tell(true);
    }
  }, on);

  // A checkbox: Shift+click selects the range; every change tells once.
  el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const check = /** @type {Element} */ (event.target)?.closest?.(CHECK);
    const card = check?.closest(CARD);
    if (!card) return;
    if (event.shiftKey && anchor && anchor !== card) {
      const value = /** @type {HTMLInputElement} */ (check).checked;
      write(between(cards(), anchor, card), value);
      anchor = card;
      told = check;
      tell(true);
      return;
    }
    anchor = card;
  }, on);

  el.addEventListener('change', (event) => {
    const check = /** @type {Element} */ (event.target)?.closest?.(CHECK);
    if (!check || !el.contains(check)) return;
    if (told === check) {
      told = null;
      return;
    }
    tell(false);
  }, on);

  el.addEventListener('focusin', park, on);
  const View = doc.defaultView?.MutationObserver;
  const observer = typeof View === 'function' ? new View(park) : null;
  park();
  observer?.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex'] });

  return {
    get() { return selected(); },
    set(keys) {
      const wanted = new Set(Array.from(keys ?? [], String));
      let changed = false;
      cards().forEach((card, index) => {
        if (write([card], wanted.has(keyOf(card, index)))) changed = true;
      });
      if (changed) tell(false);
    },
    selectAll() {
      if (write(cards(), true)) tell(false);
    },
    clear() {
      anchor = null;
      if (write(cards(), false)) tell(false);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      observer?.disconnect();
      abort.abort();
      rove.destroy();
      listeners.clear();
      for (const node of parked) {
        disown(node, 'attrs', 'tabindex');
        node.removeAttribute('tabindex');
      }
      parked.clear();
    },
  };
}

define('media', {
  attribute: 'data-ds-media',
  init(el, ctx) {
    return mediaController(el, ctx.signal);
  },
});

/**
 * A media grid driven from the page: the same controller the attribute path
 * makes (one tab stop, the keys, the selection).
 * @param {Element} el
 */
export function create(el) {
  return mediaController(el);
}
