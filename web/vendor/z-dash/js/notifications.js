/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Notification centre (DS.notifications): a bell with the unread count
 * that opens a side sheet of notifications, grouped by day (or by the
 * group each names), read and unread, with mark all read, actions per
 * notification, a settings link and an empty state; arrivals are
 * announced.
 *
 *   <span class="ds-notifications__bell">
 *     <button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-ds-open="#inbox" aria-label="Notifications" data-tip="Notifications">(bell 20)</button>
 *     [<span class="ds-badge ds-tone-error" aria-hidden="true">3</span>]   notifications.js
 *   </span>
 *   <dialog class="ds-sheet ds-notifications" id="inbox" data-ds-notifications aria-labelledby="inbox-title">
 *     <div class="ds-sheet__backdrop" data-ds-close></div>
 *     <section class="ds-sheet__panel">
 *       <div class="ds-sheet__head">
 *         <div class="ds-sheet__heading"><h2 class="ds-sheet__title" id="inbox-title">Notifications</h2>
 *           <p class="ds-sheet__subtitle"></p></div>                        notifications.js: "3 unread"
 *         <a class="ds-btn ds-btn--quiet ds-btn--icon" href="/settings/notifications" aria-label="Notification settings" data-tip="Notification settings">(settings 20)</a>
 *         <button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" aria-label="Close" data-ds-close>(close 20)</button></div>
 *       <div class="ds-notifications__bar">
 *         <label class="ds-switch"><input type="checkbox" role="switch" data-ds-notifications-unread-only> ... Only unread</label>
 *         <button class="ds-btn ds-btn--text ds-sm" type="button" data-ds-notifications-read-all>Mark all as read</button></div>
 *       <div class="ds-sheet__body ds-notifications__feed" tabindex="0"> groups, rendered here </div>
 *     </section>
 *   </dialog>
 *
 *   const centre = DS.notifications.create(sheet, { items });
 *   centre.add({ id: 'n9', title: 'LAPTOP-0042 is offline', time: new Date(), tone: 'warning', href: '/devices/42' });
 *   centre.read('n9');  centre.readAll();  centre.on('action', ({ item, action }) => ...);
 *
 * A notification: { id, title, text, time (a Date, timestamp or ISO
 * text), read, icon (a glyph of DS.icons; default the tone's: info,
 * check circle, alert, alert circle), tone (info, success, warning,
 * error: the icon's colour and glyph, and a word for screen readers, so
 * never colour alone), href (the title links there when DS.core.safeHref
 * accepts it: http, https, mailto, tel or relative; else the title is
 * plain text), group (a heading of its own instead of the day),
 * actions: [{ id, label }] }. Newest first within a group; the groups in
 * the order of their newest notification (Today, Yesterday, Earlier for
 * the days). Rows are keyed (data-ds-key) and patched in place, so focus
 * and running motion stay.
 *
 * Unread: a dot, the title in the label weight and the word "Unread" for
 * screen readers (never colour alone); the row's read button (mail open /
 * mail) toggles it. Following the title's link marks it read. A row that
 * leaves the feed while it holds focus (read with the unread-only switch
 * on, removed) hands focus to the next row's first control, else the
 * previous row's, else the feed, so focus never falls out of the sheet. Mark all
 * read ([data-ds-notifications-read-all]) is aria-disabled while nothing
 * is unread, and announces when it acted. The unread-only switch
 * ([data-ds-notifications-unread-only]) hides what was read.
 *
 * The bell: every [data-ds-open="#<id>"] inside a .ds-notifications__bell
 * (or the `bell` option) gets the count as a .ds-badge on its corner
 * (DS.badge: 99+, gone at zero, popping in and out) and the accessible
 * name "Notifications, 3 unread". The sheet's subtitle (.ds-sheet__subtitle)
 * says "3 unread".
 *
 * Arrivals: add() announces "New notification: <title>" (several within
 * one task: "3 new notifications"), politely, through DS.toast's
 * announcers, so it is heard over an open dialog; with the sheet open the
 * new row fades in and the others glide (DS.motion.flip()).
 *
 * Focus: the sheet opens with focus on the feed (autofocus, written here
 * unless the markup names another element), so the list scrolls by keys
 * and Tab goes on to the notifications.
 *
 * Events on the sheet: ds:change ({ items, unread }), ds:read ({ ids,
 * read }), ds:action ({ item, action }), ds:select ({ item }), and the
 * sheet's ds:open and ds:close (DS.overlay).
 *
 * Strings: notificationsCount, notificationsUnread,
 * notificationsUnreadCount, notificationsMarkRead,
 * notificationsMarkUnread, notificationsAllRead, notificationsArrived,
 * notificationsArrivedMany, notificationsToday, notificationsYesterday,
 * notificationsEarlier, notificationsEmpty, notificationsError,
 * notificationsWarning, notificationsSuccess.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, safeHref, t } from './core.js';
import { enter, flip } from './motion.js';
import { alert as alertGlyph, alertCircle, bell as bellGlyph, checkCircle, iconElement, info, mail, mailOpen } from './icons.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { relative, time as keepTime } from './format.js';
import { create as createBadge, format as formatCount } from './badge.js';
import { announce } from './toast.js';

/** The tones a notification's icon may take. */
const TONES = new Set(['info', 'success', 'warning', 'error', 'primary', 'neutral']);

const DAY = 86400000;

/** The time of a notification as a number (ms), or NaN. */
function stamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  return Number.NaN;
}

/** Midnight of the day of `ms`, in local time. */
function dayStart(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Which day group a time falls in, seen from `now`: 'today', 'yesterday'
 * or 'earlier' (also for no time, or one in the future past today).
 * @param {Date|number|string|null|undefined} value
 * @param {Date|number} [now]
 * @returns {'today'|'yesterday'|'earlier'}
 */
export function dayOf(value, now = Date.now()) {
  const at = stamp(value);
  if (!Number.isFinite(at)) return 'earlier';
  const today = dayStart(stamp(now));
  if (at >= today) return 'today';
  // One calendar day back (a DST change makes that day 23 or 25 hours).
  const yesterday = dayStart(today - DAY / 2);
  return at >= yesterday ? 'yesterday' : 'earlier';
}

/**
 * Notifications in groups: each its `group`, else its day (dayOf());
 * newest first inside a group (no time last, in their given order); the
 * groups in the order of their newest notification, the days as Today,
 * Yesterday, Earlier. Returns [{ key, items }], `key` the group's name or
 * 'today', 'yesterday', 'earlier'.
 * @template {{ time?: Date|number|string|null, group?: string|null }} N
 * @param {N[]} items
 * @param {{ now?: Date|number }} [options]
 * @returns {{ key: string, day: boolean, items: N[] }[]}
 */
export function groupByDay(items, options = {}) {
  const now = options.now ?? Date.now();
  const sorted = items
    .map((item, at) => ({ item, at, time: stamp(item?.time) }))
    .sort((a, b) => {
      const known = Number.isFinite(b.time) - Number.isFinite(a.time);
      if (known) return known;
      return (Number.isFinite(a.time) ? b.time - a.time : 0) || a.at - b.at;
    });
  const groups = new Map();
  for (const { item } of sorted) {
    const named = item?.group ? String(item.group) : '';
    const key = named || dayOf(item?.time, now);
    if (!groups.has(key)) groups.set(key, { key, day: !named, items: [] });
    groups.get(key).items.push(item);
  }
  // Days keep their own order among themselves; a named group sits where its newest item does.
  return [...groups.values()];
}

/** A notification as the centre keeps it. */
function normalize(given, index) {
  const title = String(given?.title ?? '').replace(/\s+/g, ' ').trim();
  return {
    ...given,
    id: String(given?.id ?? (title || `notification-${index}`)),
    title,
    text: given?.text ? String(given.text) : '',
    read: Boolean(given?.read),
    tone: given?.tone && TONES.has(String(given.tone)) ? String(given.tone) : '',
    group: given?.group ? String(given.group) : '',
    actions: Array.isArray(given?.actions) ? given.actions.filter((action) => action?.label).map((action, at) => ({ ...action, id: String(action.id ?? at), label: String(action.label) })) : [],
  };
}

/**
 * The notifications written in the markup: each .ds-notifications__item
 * with its key, data-unread, title (and its link), text, <time datetime>
 * and its group's heading (a group not named for a day).
 */
function fromMarkup(feed) {
  if (!feed) return [];
  return [...feed.querySelectorAll('.ds-notifications__item')].map((row, index) => {
    const link = row.querySelector('.ds-notifications__link');
    const heading = row.closest('.ds-notifications__group')?.querySelector('.ds-notifications__heading');
    const group = heading?.getAttribute('data-ds-notifications-day') ? '' : heading?.textContent?.trim() ?? '';
    return {
      id: row.getAttribute('data-ds-key') || `notification-${index}`,
      title: (row.querySelector('.ds-notifications__title')?.textContent ?? '').trim(),
      text: (row.querySelector('.ds-notifications__text')?.textContent ?? '').trim(),
      time: row.querySelector('time')?.getAttribute('datetime') ?? null,
      read: !row.hasAttribute('data-unread'),
      href: link?.getAttribute('href') || undefined,
      group,
    };
  });
}

let centres = 0;

/** The string of the word a screen reader hears for a tone that states a status. */
const TONE_WORDS = { error: 'notificationsError', warning: 'notificationsWarning', success: 'notificationsSuccess' };

/** The default glyph of a notification of `tone`: the meaning never rests on colour alone. */
const glyphOf = (tone) => (tone === 'error' ? alertCircle : tone === 'warning' ? alertGlyph : tone === 'success' ? checkCircle : info);

function controller(el, given = {}, signal = null) {
  const doc = el.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  centres += 1;
  const uid = el.id || `ds-notifications-${centres}`;
  const feed = el.querySelector('.ds-notifications__feed') ?? el.querySelector('.ds-sheet__body') ?? el;
  const subtitle = el.querySelector('.ds-sheet__subtitle');
  const readAll = el.querySelector('[data-ds-notifications-read-all]');
  const unreadOnly = /** @type {HTMLInputElement|null} */ (el.querySelector('[data-ds-notifications-unread-only]'));
  // Focus lands on the feed when the sheet opens (DS.overlay takes [autofocus]): the list is what it is for, and
  // no tooltip of a head button stands between Escape and the close.
  if (feed !== el && !el.querySelector('[autofocus]')) {
    if (!feed.hasAttribute('tabindex')) feed.setAttribute('tabindex', '0');
    feed.setAttribute('autofocus', '');
  }
  let items = (given.items ?? fromMarkup(feed)).map(normalize);
  const listeners = new Map();
  const lifetime = new AbortController();
  signal?.addEventListener('abort', () => lifetime.abort(), { once: true });
  /** id → { row, parts } of the rows on screen. */
  const rows = new Map();
  /** day or group key → its section. */
  const sections = new Map();
  let arrived = [];
  let arrivalTimer = 0;

  const fire = (type, detail) => {
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };
  const unread = () => items.filter((item) => !item.read).length;

  /* ── The empty state: the page's .ds-empty in the feed, else one of its own ── */
  let empty = feed.querySelector(':scope > .ds-empty, :scope > .ds-notifications__empty');
  if (!empty) {
    empty = doc.createElement('div');
    empty.className = 'ds-empty ds-notifications__empty';
    const disc = doc.createElement('span');
    disc.className = 'ds-empty__disc';
    disc.setAttribute('aria-hidden', 'true');
    disc.append(iconElement(bellGlyph, 24, undefined, doc));
    const title = doc.createElement('p');
    title.className = 'ds-empty__title';
    title.textContent = t('notificationsEmpty');
    empty.append(disc, title);
    feed.append(empty);
  }

  /* ── The bells ── */
  const bells = () => {
    const found = new Set(given.bell ? (Array.isArray(given.bell) ? given.bell : [given.bell]) : []);
    if (el.id) for (const button of doc.querySelectorAll(`.ds-notifications__bell > [data-ds-open="#${CSS.escape(el.id)}"]`)) found.add(button);
    return [...found].filter(Boolean);
  };
  /** button → { badge controller, label } */
  const bellState = new Map();
  const paintBells = () => {
    const count = unread();
    for (const button of bells()) {
      let state = bellState.get(button);
      if (!state) {
        const host = button.closest('.ds-notifications__bell') ?? button.parentElement;
        let badge = host?.querySelector(':scope > .ds-badge');
        if (!badge && host) {
          badge = doc.createElement('span');
          badge.className = 'ds-badge ds-tone-error';
          badge.setAttribute('aria-hidden', 'true');
          badge.hidden = true;
          host.append(badge);
        }
        state = {
          badge: badge ? createBadge(badge, { value: 0 }) : null,
          label: button.getAttribute('aria-label') || button.textContent.trim(),
        };
        bellState.set(button, state);
      }
      state.badge?.set(count);
      const name = count ? t('notificationsCount', { label: state.label, count: formatCount(count) }) : state.label;
      if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
    }
  };

  /* ── Rows ── */
  const headingText = (group) => {
    if (!group.day) return group.key;
    return group.key === 'today' ? t('notificationsToday') : group.key === 'yesterday' ? t('notificationsYesterday') : t('notificationsEarlier');
  };

  const sectionOf = (group) => {
    let section = sections.get(group.key);
    if (!section) {
      section = doc.createElement('section');
      section.className = 'ds-notifications__group';
      const heading = doc.createElement('h3');
      heading.className = 'ds-notifications__heading';
      heading.id = `${uid}-group-${sections.size + 1}`;
      if (group.day) heading.setAttribute('data-ds-notifications-day', group.key);
      const list = doc.createElement('ul');
      list.className = 'ds-notifications__list';
      list.setAttribute('role', 'list');
      section.setAttribute('aria-labelledby', heading.id);
      section.append(heading, list);
      sections.set(group.key, section);
    }
    const heading = section.firstElementChild;
    const text = headingText(group);
    if (heading.textContent !== text) heading.textContent = text;
    return section;
  };

  const rowOf = (item) => {
    let entry = rows.get(item.id);
    if (!entry) {
      const row = doc.createElement('li');
      row.className = 'ds-notifications__item';
      row.setAttribute('data-ds-key', item.id);
      const icon = doc.createElement('span');
      icon.className = 'ds-notifications__icon';
      icon.setAttribute('aria-hidden', 'true');
      const content = doc.createElement('div');
      content.className = 'ds-notifications__content';
      const title = doc.createElement('p');
      title.className = 'ds-notifications__title';
      title.id = `${uid}-title-${rows.size + 1}`;
      const text = doc.createElement('p');
      text.className = 'ds-notifications__text';
      const meta = doc.createElement('p');
      meta.className = 'ds-notifications__meta';
      const dot = doc.createElement('span');
      dot.className = 'ds-notifications__dot';
      dot.setAttribute('aria-hidden', 'true');
      const word = doc.createElement('span');
      word.className = 'ds-sr';
      const when = doc.createElement('time');
      meta.append(dot, word, when);
      const actions = doc.createElement('div');
      actions.className = 'ds-notifications__actions';
      content.append(title, text, meta, actions);
      const toggle = doc.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-notifications__toggle';
      toggle.setAttribute('aria-describedby', title.id);
      row.append(icon, content, toggle);
      entry = { row, icon, title, text, meta, word, when, actions, toggle, clock: null, glyph: '', state: {} };
      rows.set(item.id, entry);
    }
    paintRow(entry, item);
    return entry.row;
  };

  const paintRow = (entry, item) => {
    const { row, icon, title, text, word, when, actions, toggle, state } = entry;
    row.toggleAttribute('data-unread', !item.read);
    // The icon: its glyph and tone.
    const glyph = item.icon ?? glyphOf(item.tone);
    if (entry.glyph !== glyph) {
      icon.replaceChildren(iconElement(glyph, 20, undefined, doc));
      entry.glyph = glyph;
    }
    icon.className = item.tone ? `ds-notifications__icon ds-tone-${item.tone}` : 'ds-notifications__icon';
    // The title, linked when it goes somewhere.
    // An href from data only when safe: a javascript: or data: URL leaves the title plain text.
    const href = safeHref(item.href);
    if (state.title !== item.title || state.href !== href) {
      if (href) {
        const link = doc.createElement('a');
        link.className = 'ds-notifications__link';
        link.setAttribute('href', href);
        link.textContent = item.title;
        title.replaceChildren(link);
      } else title.textContent = item.title;
      state.title = item.title;
      state.href = href;
    }
    if (text.textContent !== item.text) text.textContent = item.text;
    text.hidden = !item.text;
    // Tone and unread in words for screen readers: never colour (or the dot) alone.
    const toneWord = TONE_WORDS[item.tone] ? `${t(TONE_WORDS[item.tone])}, ` : '';
    const words = `${toneWord}${item.read ? '' : `${t('notificationsUnread')}, `}`;
    if (word.textContent !== words) word.textContent = words;
    // The time: relative, kept current on the shared clock.
    const at = stamp(item.time);
    if (Number.isFinite(at)) {
      const iso = new Date(at).toISOString();
      if (when.getAttribute('datetime') !== iso) {
        when.setAttribute('datetime', iso);
        when.textContent = relative(at);
        if (entry.clock) entry.clock.set(at);
        else entry.clock = keepTime(when, { value: at, smallest: 'minute' });
      }
      when.hidden = false;
    } else when.hidden = true;
    // The actions: buttons keyed by the action's id.
    const keys = item.actions.map((action) => `${action.id}\u0000${action.label}`).join('\u0001');
    if (state.actions !== keys) {
      actions.replaceChildren(...item.actions.map((action) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'ds-btn ds-btn--text ds-sm';
        button.setAttribute('data-ds-key', action.id);
        button.textContent = action.label;
        return button;
      }));
      state.actions = keys;
    }
    actions.hidden = item.actions.length === 0;
    // The read button: its name says what it does.
    const label = item.read ? t('notificationsMarkUnread') : t('notificationsMarkRead');
    if (toggle.getAttribute('aria-label') !== label) {
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('data-tip', label);
      toggle.replaceChildren(iconElement(item.read ? mail : mailOpen, 20, undefined, doc));
    }
  };

  /**
   * Puts `nodes` (groups or rows) into `parent` in this order, before
   * `anchor`, moving only what is out of place; other children (a
   * sentinel, the empty state) stay where they are. A moved node that held
   * focus gets it back.
   */
  const place = (parent, nodes, anchor = null) => {
    const managed = (child) => child.classList.contains('ds-notifications__group') || child.classList.contains('ds-notifications__item');
    const current = [...parent.children].filter(managed);
    if (current.length === nodes.length && current.every((node, at) => node === nodes[at])) return;
    const focused = doc.activeElement;
    const wanted = new Set(nodes);
    for (const child of current) if (!wanted.has(child)) child.remove();
    let ref = anchor?.parentNode === parent ? anchor : null;
    for (let at = nodes.length - 1; at >= 0; at -= 1) {
      const node = nodes[at];
      if (node.parentNode !== parent || node.nextElementSibling !== ref) parent.insertBefore(node, ref);
      ref = node;
    }
    if (focused && focused !== doc.activeElement && focused.isConnected) /** @type {HTMLElement} */ (focused).focus({ preventScroll: true });
  };

  /**
   * When focus sits in a row about to leave the feed (read with the
   * unread-only switch on, removed), moves it first, so it never falls out
   * of the sheet: to the first control of the next row that stays, else of
   * the previous one, else to the feed.
   */
  const handOff = (staying) => {
    const row = doc.activeElement?.closest?.('.ds-notifications__item');
    if (!row || !feed.contains(row) || staying.has(row.getAttribute('data-ds-key'))) return;
    const all = [...feed.querySelectorAll('.ds-notifications__item')];
    const at = all.indexOf(row);
    const stays = (node) => staying.has(node.getAttribute('data-ds-key'));
    const next = all.slice(at + 1).find(stays) ?? all.slice(0, at).reverse().find(stays);
    const target = next?.querySelector('a[href], button') ?? feed;
    /** @type {HTMLElement} */ (target).focus({ preventScroll: true });
  };

  const paint = (animate = false) => {
    const filtered = unreadOnly?.checked ? items.filter((item) => !item.read) : items;
    handOff(new Set(filtered.map((item) => item.id)));
    const groups = groupByDay(filtered);
    const appeared = [];
    const change = () => {
      const nodes = groups.map((group) => {
        const section = sectionOf(group);
        const list = section.querySelector('.ds-notifications__list');
        const rowNodes = group.items.map((item) => {
          const known = rows.has(item.id) && rows.get(item.id).row.isConnected;
          const row = rowOf(item);
          if (!known) appeared.push(row);
          return row;
        });
        place(list, rowNodes);
        return section;
      });
      place(feed, nodes, empty);
      if (empty.parentNode !== feed || empty.nextElementSibling) feed.append(empty);
      empty.hidden = filtered.length > 0;
      // Rows of notifications that are gone release their clock.
      const ids = new Set(items.map((item) => item.id));
      for (const [id, entry] of rows) {
        if (ids.has(id)) continue;
        entry.clock?.destroy();
        entry.row.remove();
        rows.delete(id);
      }
    };
    const shown = el.getAttribute('data-state') === 'open' || el.hasAttribute('open');
    if (animate && shown) {
      flip(feed, change);
      for (const row of appeared) enter(row, 'fade');
    } else change();
    paintCounts();
  };

  const paintCounts = () => {
    const count = unread();
    if (subtitle) {
      const text = count ? t('notificationsUnreadCount', { count: formatCount(count) }) : '';
      if (subtitle.textContent !== text) subtitle.textContent = text;
    }
    if (readAll) {
      if (count) readAll.removeAttribute('aria-disabled');
      else readAll.setAttribute('aria-disabled', 'true');
    }
    paintBells();
  };

  const changed = (animate) => {
    paint(animate);
    fire('change', { items: items.map((item) => ({ ...item })), unread: unread() });
  };

  const setRead = (ids, read) => {
    const touched = [];
    for (const item of items) {
      if (ids.includes(item.id) && item.read !== read) {
        item.read = read;
        touched.push(item.id);
      }
    }
    if (!touched.length) return touched;
    changed(false);
    fire('read', { ids: touched, read });
    return touched;
  };

  /* ── Arrivals ── */
  const speak = () => {
    const list = arrived;
    arrived = [];
    if (!list.length) return;
    const text = list.length === 1 ? t('notificationsArrived', { title: list[0].title }) : t('notificationsArrivedMany', { count: list.length });
    announce(text);
  };

  /* ── Events ── */
  const options = { signal: lifetime.signal };
  feed.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    const row = target.closest?.('.ds-notifications__item');
    if (!row || !feed.contains(row)) return;
    const item = items.find((each) => each.id === row.getAttribute('data-ds-key'));
    if (!item) return;
    if (target.closest('.ds-notifications__toggle')) {
      setRead([item.id], !item.read);
      return;
    }
    const button = target.closest('.ds-notifications__actions > button');
    if (button) {
      const action = item.actions.find((each) => each.id === button.getAttribute('data-ds-key'));
      if (!action) return;
      fire('action', { item: { ...item }, action });
      try {
        action.run?.(item, api);
      } catch (error) {
        view.reportError?.(error);
      }
      return;
    }
    if (target.closest('.ds-notifications__link')) {
      setRead([item.id], true);
      fire('select', { item: { ...item } });
    }
  }, options);
  readAll?.addEventListener('click', () => {
    if (readAll.getAttribute('aria-disabled') === 'true') return;
    const touched = setRead(items.map((item) => item.id), true);
    if (touched.length) announce(t('notificationsAllRead'));
  }, options);
  unreadOnly?.addEventListener('change', () => paint(true), options);

  paint(false);

  const api = {
    get() {
      return items.map((item) => ({ ...item }));
    },
    set(next) {
      items = (Array.isArray(next) ? next : []).map(normalize);
      changed(true);
    },
    add(next, addOptions = {}) {
      const list = (Array.isArray(next) ? next : [next]).filter(Boolean).map((item, at) => normalize(item, items.length + at));
      if (!list.length) return;
      const ids = new Set(list.map((item) => item.id));
      items = [...list, ...items.filter((item) => !ids.has(item.id))];
      changed(true);
      if (addOptions.announce === false) return;
      arrived.push(...list.filter((item) => !item.read));
      view.clearTimeout(arrivalTimer);
      // One announcement for what arrives in one task.
      arrivalTimer = view.setTimeout(speak, 0);
    },
    update(id, patch = {}) {
      const at = items.findIndex((item) => item.id === id);
      if (at < 0) return;
      items[at] = normalize({ ...items[at], ...patch, id }, at);
      changed(false);
    },
    remove(id) {
      const before = items.length;
      items = items.filter((item) => item.id !== id);
      if (items.length === before) return;
      // paint() moves focus on before the row goes.
      changed(true);
    },
    read(id, read = true) {
      setRead([id], read);
    },
    readAll() {
      setRead(items.map((item) => item.id), true);
    },
    unread,
    open: (openOptions = {}) => openOverlay(el, { opener: openOptions.opener ?? doc.activeElement }),
    close: () => closeOverlay(el),
    refresh: () => paint(false),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      made.delete(el);
      lifetime.abort();
      view.clearTimeout(arrivalTimer);
      for (const entry of rows.values()) entry.clock?.destroy();
      for (const state of bellState.values()) state.badge?.destroy();
      for (const [button, state] of bellState) button.setAttribute('aria-label', state.label);
      bellState.clear();
      listeners.clear();
    },
  };
  return api;
}

const made = new WeakMap();

define('notifications', {
  attribute: 'data-ds-notifications',
  init(el, ctx) {
    const known = made.get(el);
    if (known) return known;
    const centre = controller(el, {}, ctx.signal);
    made.set(el, centre);
    const destroy = centre.destroy;
    centre.destroy = () => {
      made.delete(el);
      destroy();
    };
    return centre;
  },
});

/**
 * The notification centre of `el` (a .ds-sheet.ds-notifications): the same
 * controller data-ds-notifications makes. `items` replaces the
 * notifications of the markup; `bell` names bells besides those found by
 * data-ds-open. Once per element: a second call returns the same
 * controller with `items` set.
 * @param {Element} el
 * @param {{ items?: object[], bell?: Element|Element[] }} [options]
 */
export function create(el, options = {}) {
  const known = made.get(el);
  if (known) {
    if (options.items) known.set(options.items);
    return known;
  }
  const centre = controller(el, options);
  made.set(el, centre);
  return centre;
}

/**
 * Opens the notification centre of `el` (made on first use) through
 * DS.overlay.
 * @param {Element} el
 * @param {{ opener?: Element|null }} [options]
 * @returns {Promise<void>}
 */
export function open(el, options = {}) {
  return create(el).open(options);
}

/**
 * Closes the notification centre of `el` through DS.overlay.
 * @param {Element} el
 * @returns {Promise<void>}
 */
export function close(el) {
  return closeOverlay(el);
}
