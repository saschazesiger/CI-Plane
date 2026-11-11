/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Avatar (DS.avatar): initials and a colour of their own from a name, the
 * name as the avatar's label, a status dot with its word in that label; and
 * a group that shows a few avatars and lists the rest in a menu behind "+N".
 *
 *   <span class="ds-avatar" data-ds-avatar="Ada Lovelace" data-ds-avatar-status="online"></span>
 *     -> class ds-avatar--hue-3, text "AL", role="img", aria-label="Ada Lovelace, Online",
 *        a .ds-presence-dot--online inside
 *   DS.avatar.initials('Ada Lovelace');   'AL'
 *   DS.avatar.hue('Ada Lovelace');        1 ... 6, the same on every page and server
 *   const ada = DS.avatar.create(el, { name: 'Ada Lovelace', status: 'away' });
 *   ada.set({ status: 'busy' });
 *
 *   <div class="ds-avatar-group" data-ds-avatar-group data-ds-avatar-group-max="4"> avatars ...
 *     <button class="ds-avatar ds-avatar-group__more" type="button" aria-haspopup="menu" data-ds-open="#more"></button>
 *     <div class="ds-menu" role="menu" id="more" hidden></div>
 *   </div>
 *   const team = DS.avatar.group(el, { max: 4 });
 *
 * An avatar: the initials go in only where the markup has no content of its
 * own (a picture, an icon, text), the hue class only where it has none, the
 * label only where it is no aria-hidden decoration and has no label of its
 * own (an <img> gets alt). What it writes is owned state (DS.dom.own) or a
 * kept part (the initials and the dot, data-ds-keep), so a
 * re-render with DS.dom.morphHtml keeps it. A group: past the maximum it
 * shows max - 1 avatars and "+N" (so the row never grows past max discs),
 * hides the rest, names the "+N" button ("3 more") and writes the menu it
 * opens (aria-controls or data-ds-open) with one item per hidden avatar: a
 * link for a linked avatar, else a button that presses the avatar it stands
 * for (when that one is a button) and sends ds:select ({ avatar, name }) on
 * the group. It follows avatars added, removed or renamed. When the group
 * shrinks while focus is on "+N" or in its menu, focus stays in the group:
 * the menu closes once nothing is left to list (DS.overlay.close) and focus
 * goes to the last interactive avatar shown (else the group itself, with
 * tabindex="-1"); a focused item that goes moves focus to the item now at
 * its place.
 *
 * Strings: avatarStatus, avatarMore, avatarOverflow and the presence words
 * (presenceOnline, presenceAway, presenceBusy, presenceOffline).
 *
 * ES2022. Progressive:
 * - Intl.Segmenter (initials of combined characters, an emoji flag): without
 *   it a code point stands for a character.
 */
import { define, emit, t } from './core.js';
import { own, disown, morphChildren } from './dom.js';
import { canFocus, close } from './overlay.js';

/** The hue classes, 1 ... HUES. */
const HUES = 6;

const STATUSES = ['online', 'away', 'busy', 'offline'];
const STATUS_WORDS = { online: 'presenceOnline', away: 'presenceAway', busy: 'presenceBusy', offline: 'presenceOffline' };

const HUE_CLASS = /(?:^|\s)ds-avatar--hue-\d(?:\s|$)/;

/** The characters of a text as people count them. */
function characters(text) {
  const Segmenter = globalThis.Intl?.Segmenter;
  if (typeof Segmenter === 'function') return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
  return Array.from(text);
}

const LETTER = /[\p{L}\p{N}]/u;

/**
 * The initials of a name: the first letter of its first and last word, upper
 * case (`max` 1: the first only). Words in brackets are left out ("Ada
 * Lovelace (admin)"); an e-mail address counts by its local part
 * (ada.lovelace@ ... gives AL). An empty string for a name without a letter.
 * @param {string} name
 * @param {number} [max]
 * @returns {string}
 */
export function initials(name, max = 2) {
  let text = String(name ?? '').normalize('NFC').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim();
  const at = text.indexOf('@');
  if (at > 0 && !/\s/.test(text)) text = text.slice(0, at).replace(/[._+-]+/g, ' ');
  const words = text.split(/[\s]+/).filter((word) => LETTER.test(word));
  if (!words.length) return '';
  const first = (word) => characters(word).find((char) => LETTER.test(char)) ?? '';
  const picked = max > 1 && words.length > 1 ? [words[0], words.at(-1)] : [words[0]];
  return picked.map(first).join('').toLocaleUpperCase();
}

/**
 * The hue of a name, 1 ... 6: FNV-1a (32 bit) over the UTF-8 bytes of the
 * name, trimmed, NFC and lower case, modulo 6, plus 1. The same on every
 * page, so a server that renders .ds-avatar--hue-<n> itself agrees with it.
 * @param {string} name
 * @returns {number}
 */
export function hue(name) {
  const bytes = new TextEncoder().encode(String(name ?? '').normalize('NFC').trim().toLowerCase());
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % HUES) + 1;
}

/** A status the dot knows, or ''. */
const statusOf = (value) => (STATUSES.includes(value) ? value : '');

/** Whether the markup gives the avatar content of its own (a picture, an icon, a text), besides the parts this controller writes. */
function hasOwnContent(el, mine) {
  for (const node of el.childNodes) {
    if (node === mine) continue;
    if (node.nodeType === 1) {
      if (/** @type {Element} */ (node).matches('.ds-presence-dot, .ds-badge')) continue;
      return true;
    }
    if (node.nodeType === 3 && node.textContent.trim()) return true;
  }
  return false;
}

/** An attribute this controller writes, owned so a morph keeps it; `previous` remembers the page's value. */
function writer(el) {
  const written = new Map();
  return {
    set(name, value) {
      if (!written.has(name)) {
        written.set(name, el.getAttribute(name));
        own(el, 'attrs', name);
      }
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    },
    has: (name) => written.has(name),
    restore() {
      for (const [name, before] of written) {
        disown(el, 'attrs', name);
        if (before === null) el.removeAttribute(name);
        else el.setAttribute(name, before);
      }
      written.clear();
    },
  };
}

function avatarController(el, start, signal) {
  let state = { name: start.name ?? '', status: statusOf(start.status) };
  /** @type {HTMLElement|null} the initials, a kept part (a morph leaves it) */
  let letters = null;
  let hueClass = '';
  /** @type {HTMLElement|null} */
  let dot = null;
  const attrs = writer(el);
  const listeners = new Set();
  const pageLabel = el.getAttribute('aria-label');
  const pageAlt = el.getAttribute('alt');

  const render = () => {
    const doc = el.ownerDocument;
    // The colour: a hue class of the page's stays.
    const wanted = state.name && !(HUE_CLASS.test(el.className) && !hueClass) ? `ds-avatar--hue-${hue(state.name)}` : '';
    if (hueClass !== wanted) {
      if (hueClass) {
        el.classList.remove(hueClass);
        disown(el, 'classes', hueClass);
      }
      if (wanted) {
        el.classList.add(wanted);
        own(el, 'classes', wanted);
      }
      hueClass = wanted;
    }
    // The initials, where the markup brings no content: a kept span, so a
    // re-render with morphHtml leaves them, as it leaves the dot.
    if (el.tagName !== 'IMG' && !hasOwnContent(el, letters)) {
      const next = initials(state.name, Number(el.getAttribute('data-ds-avatar-initials')) === 1 ? 1 : 2);
      if (!letters) {
        letters = doc.createElement('span');
        letters.setAttribute('data-ds-keep', '');
        el.prepend(letters);
      }
      if (letters.textContent !== next) letters.textContent = next;
    } else if (letters) {
      letters.remove();
      letters = null;
    }
    // The status dot, a part this controller owns.
    if (state.status && el.tagName !== 'IMG') {
      if (!dot) {
        dot = doc.createElement('span');
        dot.setAttribute('data-ds-keep', '');
        el.append(dot);
      }
      dot.className = `ds-presence-dot ds-presence-dot--${state.status}`;
    } else if (dot) {
      dot.remove();
      dot = null;
    }
    // The label: the name, and the status word.
    if (el.getAttribute('aria-hidden') === 'true' || !state.name) return;
    const name = (el.tagName === 'IMG' ? pageAlt : pageLabel) || state.name;
    const label = state.status ? t('avatarStatus', { name, status: t(STATUS_WORDS[state.status]) }) : name;
    if (el.tagName === 'IMG') {
      attrs.set('alt', label);
      return;
    }
    if (!el.hasAttribute('role') && !el.matches('a[href], button')) attrs.set('role', 'img');
    if (attrs.has('aria-label') || label !== pageLabel) attrs.set('aria-label', label);
  };

  render();

  return {
    get() { return { ...state }; },
    set(next) {
      const value = typeof next === 'string' ? { name: next } : next ?? {};
      const before = state;
      state = { name: value.name ?? state.name, status: 'status' in value ? statusOf(value.status) : state.status };
      render();
      if ((before.name !== state.name || before.status !== state.status) && !signal?.aborted) {
        const detail = { ...state };
        emit(el, 'change', detail);
        listeners.forEach((fn) => fn(detail));
      }
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      state = { name: el.getAttribute('data-ds-avatar') ?? state.name, status: statusOf(el.getAttribute('data-ds-avatar-status')) };
      render();
    },
    destroy() {
      listeners.clear();
      attrs.restore();
      if (hueClass) {
        disown(el, 'classes', hueClass);
        el.classList.remove(hueClass);
        hueClass = '';
      }
      dot?.remove();
      dot = null;
      letters?.remove();
      letters = null;
    },
  };
}

define('avatar', {
  attribute: 'data-ds-avatar',
  attributes: ['data-ds-avatar-status', 'data-ds-avatar-initials'],
  init(el, ctx) {
    return avatarController(el, { name: el.getAttribute('data-ds-avatar') ?? '', status: el.getAttribute('data-ds-avatar-status') }, ctx.signal);
  },
});

/**
 * An avatar driven from the page: initials, hue, label and status dot from
 * `name` and `status`; the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ name?: string, status?: 'online'|'away'|'busy'|'offline'|null }} [options]
 */
export function create(el, options = {}) {
  return avatarController(el, { name: options.name ?? '', status: options.status ?? '' });
}

/* ── Group ─────────────────────────────────────────── */

const DEFAULT_MAX = 4;

/** The maximum an attribute or option names, or the default. */
function maximum(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX;
}

/** The name an avatar shows: its data-ds-avatar, label, alt or text. */
function nameOf(avatar) {
  const img = avatar.tagName === 'IMG' ? avatar : avatar.querySelector('img');
  return (avatar.getAttribute('data-ds-avatar') || avatar.getAttribute('aria-label') || img?.getAttribute('alt') || avatar.getAttribute('title') || avatar.textContent || '').trim();
}

/** The menu the "+N" button opens: aria-controls, else data-ds-open. */
function menuOf(group, more) {
  if (!more) return null;
  const doc = group.ownerDocument;
  const id = more.getAttribute('aria-controls');
  const byId = id ? doc.getElementById(id) : null;
  if (byId) return byId;
  const target = more.getAttribute('data-ds-open') ?? '';
  if (!target) return null;
  try {
    return doc.querySelector(target.startsWith('#') || /^[.[]/.test(target) ? target : `#${target}`);
  } catch {
    return null;
  }
}

/** One menu item for a hidden avatar, built with DOM APIs. */
function itemFor(doc, avatar, index) {
  const link = avatar.matches('a[href]') ? avatar : null;
  const item = doc.createElement(link ? 'a' : 'button');
  item.className = 'ds-menu__item';
  item.setAttribute('role', 'menuitem');
  item.setAttribute('data-ds-key', avatar.getAttribute('data-ds-key') || `avatar-${index}`);
  if (link) item.setAttribute('href', link.getAttribute('href'));
  else item.setAttribute('type', 'button');
  const name = nameOf(avatar);
  const face = doc.createElement('span');
  const keep = [...avatar.classList].filter((cls) => /^ds-avatar--(hue-\d|square)$/.test(cls));
  face.className = ['ds-avatar', 'ds-sm', ...keep].join(' ');
  face.setAttribute('aria-hidden', 'true');
  const img = avatar.tagName === 'IMG' ? avatar : avatar.querySelector(':scope > img');
  if (img?.getAttribute('src')) {
    const picture = doc.createElement('img');
    picture.setAttribute('src', img.getAttribute('src'));
    picture.setAttribute('alt', '');
    face.append(picture);
  } else {
    const glyph = avatar.querySelector(':scope > svg');
    if (glyph) face.append(glyph.cloneNode(true));
    else face.append(doc.createTextNode(initials(name)));
  }
  const label = doc.createElement('span');
  label.className = 'ds-menu__label';
  label.textContent = name;
  item.append(face, label);
  const status = STATUSES.find((value) => avatar.querySelector(`:scope > .ds-presence-dot--${value}`));
  if (status) {
    const meta = doc.createElement('span');
    meta.className = 'ds-menu__meta ds-presence-label';
    const dot = doc.createElement('span');
    dot.className = `ds-presence-dot ds-presence-dot--${status}`;
    meta.append(dot, doc.createTextNode(t(STATUS_WORDS[status])));
    item.append(meta);
  }
  return item;
}

function groupController(el, start, signal) {
  let max = start.max;
  const listeners = new Set();
  const hiddenByUs = new Set();
  const doc = el.ownerDocument;
  /** @type {Map<Element, Element>} item -> avatar */
  let owners = new Map();
  let moreAttrs = null;
  let menuAttrs = null;
  let menuSeen = null;
  /** The group's own attributes this controller writes (tabindex="-1" when focus has nowhere else to go). */
  const groupAttrs = writer(el);
  let shown = 0;
  let rest = 0;

  /** Gives the "+N" button back as the page wrote it. */
  const releaseMore = () => {
    if (!moreAttrs) return;
    moreAttrs.w.restore();
    if (moreAttrs.hid) {
      disown(moreAttrs.el, 'attrs', 'hidden');
      moreAttrs.el.hidden = false;
    }
    moreAttrs = null;
  };

  const avatars = () => [...el.children].filter((child) => child.classList.contains('ds-avatar') && !child.classList.contains('ds-avatar-group__more'));
  const moreButton = () => el.querySelector(':scope > .ds-avatar-group__more');

  /** Where focus goes when what held it ("+N", an item, a hidden avatar) goes: the last interactive avatar shown, else the group. */
  const keepFocus = (shownAvatars) => {
    const target = [...shownAvatars].reverse().find((avatar) => avatar.matches('a[href], button') && canFocus(avatar));
    if (target) {
      target.focus();
      return;
    }
    if (!el.hasAttribute('tabindex') || groupAttrs.has('tabindex')) groupAttrs.set('tabindex', '-1');
    /** @type {HTMLElement} */ (el).focus();
  };

  const render = () => {
    const all = avatars();
    // Past the maximum the "+N" takes the last place.
    const visible = all.length > max ? Math.max(1, max - 1) : all.length;
    const more = moreButton();
    const menu = menuOf(el, more);
    // Where focus is now, so it does not fall to <body> when its element goes.
    const active = doc.activeElement;
    const inMenu = Boolean(menu && active && menu.contains(active));
    const focusedItem = inMenu ? [...menu.querySelectorAll('.ds-menu__item')].indexOf(active.closest('.ds-menu__item')) : -1;
    const onMore = Boolean(more && active === more);
    const onAvatar = Boolean(active && all.includes(active));
    for (const [index, avatar] of all.entries()) {
      const hide = index >= visible;
      if (hide && !hiddenByUs.has(avatar)) {
        if (avatar.hidden) continue;
        hiddenByUs.add(avatar);
        own(avatar, 'attrs', 'hidden');
        avatar.hidden = true;
      } else if (!hide && hiddenByUs.has(avatar)) {
        hiddenByUs.delete(avatar);
        disown(avatar, 'attrs', 'hidden');
        avatar.hidden = false;
      }
    }
    for (const avatar of hiddenByUs) {
      if (!all.includes(avatar)) hiddenByUs.delete(avatar);
    }
    const hidden = all.slice(visible);
    shown = visible;
    rest = hidden.length;
    // Nothing left to list: an open menu of the rest closes before its opener goes.
    if (!rest && menu && menu.getAttribute('data-state') === 'open') close(menu);
    if (more) {
      if (!moreAttrs || moreAttrs.el !== more) {
        releaseMore();
        moreAttrs = { el: more, w: writer(more), hid: false };
      }
      const text = rest ? t('avatarOverflow', { count: rest }) : '';
      if (more.textContent !== text) more.textContent = text;
      moreAttrs.w.set('aria-label', t('avatarMore', { count: rest }));
      // Nothing to list: the button goes (hidden, owned while this hides it).
      if (!rest && !more.hidden) {
        moreAttrs.hid = true;
        own(more, 'attrs', 'hidden');
        more.hidden = true;
      } else if (rest && moreAttrs.hid) {
        moreAttrs.hid = false;
        disown(more, 'attrs', 'hidden');
        more.hidden = false;
      }
    }
    if (menu) {
      if (menuSeen !== menu) {
        menuAttrs?.restore();
        menuAttrs = writer(menu);
        menuSeen = menu;
        menu.addEventListener('click', onItem, { signal: abort.signal });
      }
      if (!menu.hasAttribute('aria-labelledby') && (!menu.hasAttribute('aria-label') || menuAttrs.has('aria-label'))) menuAttrs.set('aria-label', t('avatarMore', { count: rest }));
      const items = hidden.map((avatar, index) => itemFor(doc, avatar, visible + index));
      owners = new Map(items.map((item, index) => [item.getAttribute('data-ds-key'), hidden[index]]));
      morphChildren(menu, items);
    }
    // Focus that lost its element finds the nearest one left.
    const now = doc.activeElement;
    if (inMenu && rest && menu && !menu.contains(now)) {
      const left = [...menu.querySelectorAll('.ds-menu__item')];
      const item = left[Math.min(Math.max(focusedItem, 0), left.length - 1)];
      if (item && canFocus(item)) /** @type {HTMLElement} */ (item).focus();
      else keepFocus(all.slice(0, visible));
    } else if ((inMenu || onMore) && (!rest || !canFocus(more)) && !(now && el.contains(now) && canFocus(now) && !menu?.contains(now))) {
      keepFocus(all.slice(0, visible));
    } else if (onAvatar && !canFocus(active)) {
      if (rest && more && canFocus(more)) /** @type {HTMLElement} */ (more).focus();
      else keepFocus(all.slice(0, visible));
    }
  };

  /** A menu item: the avatar it stands for is pressed (a button) and the page hears ds:select. */
  const onItem = (event) => {
    const item = /** @type {Element} */ (event.target)?.closest?.('.ds-menu__item');
    if (!item) return;
    const avatar = owners.get(item.getAttribute('data-ds-key'));
    if (!avatar) return;
    emit(el, 'select', { avatar, name: nameOf(avatar) });
    if (avatar.matches('button')) /** @type {HTMLElement} */ (avatar).click();
  };

  const abort = new AbortController();
  signal?.addEventListener('abort', () => abort.abort(), { once: true });

  // Avatars added, removed or renamed: render again (not for what this controller writes).
  const View = doc.defaultView?.MutationObserver;
  const observer = typeof View === 'function' ? new View((records) => {
    const more = moreButton();
    const menu = menuOf(el, more);
    const relevant = records.some((record) => {
      const target = /** @type {Node} */ (record.target);
      if (menu?.contains(target) || more?.contains(target)) return false;
      if (record.type === 'attributes' && record.attributeName === 'hidden') return false;
      return true;
    });
    if (relevant) render();
  }) : null;

  render();
  observer?.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ds-avatar', 'aria-label', 'src', 'alt', 'class'] });
  observer?.takeRecords();

  return {
    get() { return { max, shown, hidden: rest }; },
    set(next) {
      const value = maximum(next);
      if (value === max) return;
      max = value;
      render();
      observer?.takeRecords();
      if (signal?.aborted) return;
      const detail = { max, shown, hidden: rest };
      emit(el, 'change', detail);
      listeners.forEach((fn) => fn(detail));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      max = maximum(el.getAttribute('data-ds-avatar-group-max'));
      render();
      observer?.takeRecords();
    },
    destroy() {
      observer?.disconnect();
      abort.abort();
      listeners.clear();
      for (const avatar of hiddenByUs) {
        disown(avatar, 'attrs', 'hidden');
        avatar.hidden = false;
      }
      hiddenByUs.clear();
      releaseMore();
      menuAttrs?.restore();
      menuAttrs = null;
      groupAttrs.restore();
    },
  };
}

define('avatar-group', {
  attribute: 'data-ds-avatar-group',
  attributes: ['data-ds-avatar-group-max'],
  init(el, ctx) {
    return groupController(el, { max: maximum(el.getAttribute('data-ds-avatar-group-max')) }, ctx.signal);
  },
});

/**
 * A group driven from the page: at most `max` discs, the rest behind "+N";
 * the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ max?: number }} [options]
 */
export function group(el, options = {}) {
  return groupController(el, { max: maximum(options.max) });
}
