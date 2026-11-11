/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Key combos (DS.kbd): a shortcut written as the keys of this platform,
 * one .ds-kbd per key, read out in words.
 *
 *   <kbd class="ds-kbd-combo" data-ds-kbd="mod+shift+k"></kbd>     ⇧ ⌘ K on Apple systems, Ctrl + Shift + K elsewhere
 *   <kbd class="ds-kbd-combo" data-ds-kbd="g i"></kbd>             G then I (a sequence)
 *   DS.kbd.keys('mod+k').spoken;                                   'Command K' or 'Ctrl K'
 *   const combo = DS.kbd.create(el, { combo: 'mod+s' });
 *
 * A combo is DS.hotkeys' (parse()): modifiers and one key joined by +,
 * `mod` Command on Apple systems and Control elsewhere; combos separated
 * by spaces are a sequence, pressed one after the other. The platform is
 * DS.hotkeys.isApple() unless data-ds-kbd-platform (or `platform`) says
 * "apple" or "other" (a page that documents both).
 *
 * The element gets its keys as children: a .ds-kbd per key in an
 * aria-hidden group, "+" between them where the platform writes it (not on
 * Apple systems), each combo in a .ds-kbd-combo__combo that never breaks,
 * "then" between the combos of a sequence, and one .ds-sr
 * text with the keys in words ("Command Shift K"), so a screen reader
 * never spells glyphs. A combo it cannot read leaves the element's text as
 * it is and reports the error.
 *
 * The controller: get() gives { combo, spoken, aria } (aria: the value for
 * aria-keyshortcuts on the control the shortcut presses), set(combo)
 * writes a new one, on('change', fn), update(), destroy() (the keys stay).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { format, isApple } from './hotkeys.js';

/** The Apple modifier glyphs, by the string that names them in words. */
const GLYPH_STRINGS = { '⌃': 'kbdControl', '⌥': 'kbdOption', '⇧': 'keyShift', '⌘': 'kbdCommand' };

/**
 * A combo or a sequence as keys: `combos` one entry per combo of the
 * sequence (`keys`, the labels; `text`, the one line), `spoken` the words
 * for a screen reader, `aria` the value of aria-keyshortcuts. Throws on a
 * combo DS.hotkeys cannot read.
 * @param {string} combo
 * @param {{ apple?: boolean }} [options]
 * @returns {{ combos: { keys: string[], text: string }[], spoken: string, aria: string, apple: boolean }}
 */
export function keys(combo, options = {}) {
  const apple = options.apple ?? isApple();
  const parts = String(combo ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('DS.kbd: no combo');
  const combos = parts.map((part) => format(part, { apple }));
  const words = combos.map(({ keys: labels }) => labels.map((label, index) => (apple && index < labels.length - 1 && Object.hasOwn(GLYPH_STRINGS, label) ? t(GLYPH_STRINGS[label]) : label)).join(' '));
  return {
    combos: combos.map(({ keys: labels, text }) => ({ keys: labels, text })),
    spoken: words.join(` ${t('kbdThen')} `),
    aria: combos.map(({ aria }) => aria).join(' '),
    apple,
  };
}

function platformOf(el, given) {
  const named = given ?? el.getAttribute('data-ds-kbd-platform');
  return named === 'apple' ? true : named === 'other' ? false : isApple(el.ownerDocument?.defaultView ?? globalThis);
}

function render(el, data) {
  const doc = el.ownerDocument;
  const make = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const shown = make('span', 'ds-kbd-combo__keys');
  shown.setAttribute('aria-hidden', 'true');
  data.combos.forEach((combo, at) => {
    if (at) shown.append(make('span', 'ds-kbd-combo__then', t('kbdThen')));
    const group = make('span', 'ds-kbd-combo__combo');
    combo.keys.forEach((label, index) => {
      if (index && !data.apple) group.append(make('span', 'ds-kbd-combo__plus', '+'));
      group.append(make('kbd', 'ds-kbd', label));
    });
    shown.append(group);
  });
  el.replaceChildren(shown, make('span', 'ds-sr', data.spoken));
}

function controller(el, given) {
  const listeners = new Set();
  let combo = given.combo ?? el.getAttribute('data-ds-kbd') ?? '';
  let data = null;

  const write = () => {
    try {
      data = keys(combo, { apple: platformOf(el, given.platform) });
    } catch (error) {
      data = null;
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
      return false;
    }
    render(el, data);
    return true;
  };
  write();

  return {
    get() {
      return { combo, spoken: data?.spoken ?? '', aria: data?.aria ?? '' };
    },
    set(next) {
      if (next === combo) return;
      combo = String(next ?? '');
      if (el.hasAttribute('data-ds-kbd')) el.setAttribute('data-ds-kbd', combo);
      if (!write()) return;
      const detail = { combo, spoken: data.spoken, aria: data.aria };
      emit(el, 'change', detail);
      for (const fn of [...listeners]) fn(detail);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      combo = el.getAttribute('data-ds-kbd') ?? combo;
      write();
    },
    destroy() {
      listeners.clear();
    },
  };
}

define('kbd', {
  attribute: 'data-ds-kbd',
  attributes: ['data-ds-kbd-platform'],
  init(el) {
    return controller(el, {});
  },
});

/**
 * Keys driven from the page; the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ combo?: string, platform?: 'apple'|'other' }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options);
}
