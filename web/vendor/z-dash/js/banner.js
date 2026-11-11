/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Banner (DS.banner): messages for the whole app (a system broadcast,
 * maintenance, offline) in the .ds-banner above the view, in priority
 * order, each dismissible with the dismissal remembered through DS.store.
 *
 *   <div class="ds-banner" data-ds-banner>
 *     <div class="ds-alert ds-tone-error" role="alert" data-ds-banner-id="outage-1104">(alertCircle 20)
 *       <span class="ds-alert__text">Sign-in is down. We are on it.</span></div>
 *     <div class="ds-alert ds-tone-info" role="status" data-ds-banner-id="maintenance-1109">(info 20)
 *       <span class="ds-alert__text">Maintenance on Sunday, 02:00 to 04:00.</span>
 *       <a class="ds-btn ds-btn--text ds-sm" href="/status">Details</a></div>
 *   </div>
 *
 *   const banner = DS.banner.create(el, { banners: [{ id, tone, title, text, action, priority }] });
 *   banner.add({ id: 'offline', tone: 'warning', text: 'You are offline.', dismissible: false });
 *   banner.dismiss('maintenance-1109');  banner.restore('maintenance-1109');
 *
 * Order: the highest data-ds-banner-priority (a number) first; without
 * one, by tone: error, warning, info, primary, the neutral alert, then
 * success; equal ones keep the order of the markup. The first
 * data-ds-banner-max (default 1) show; the others wait behind a
 * .ds-banner__more button ("Show 2 more", aria-expanded) that shows them
 * all, and hides them again.
 *
 * Dismissal: an alert with data-ds-banner-id gets a .ds-banner__dismiss
 * button (unless it has one, or data-ds-banner-dismiss="off"); a press
 * hides it and remembers its id under the namespace "banner" of DS.store
 * (data-ds-banner-remember on the banner: "local", the default, "session"
 * or "off"), so it stays away after a reload and in every tab. A new
 * broadcast takes a new id. An alert without an id is not dismissible
 * (nothing to remember). Focus goes to the next message's dismiss button,
 * else to the more button, else to the view (.ds-view), never the body.
 * A banner with nothing to show is hidden, so it takes no room. A change
 * of data-ds-banner-max or data-ds-banner-remember applies at once and
 * keeps the controller and its messages from data (update()).
 *
 * Links from data: an action's href only when DS.core.safeHref() accepts
 * it (http, https, mailto, tel or relative); else the action is a button.
 *
 * Motion: shown, hidden and dismissed messages change inside
 * DS.motion.flip() on the banner's parent (the .ds-panel), so the view
 * glides and nothing animates a height; a message that appears fades in.
 *
 * Screen readers: the alerts of the markup keep their role (alert or
 * status); a message from data has none of its own and is announced when
 * add() or set() shows it (an error assertively, through DS.toast's
 * announcers).
 *
 * Events on the banner: ds:dismiss ({ id }), ds:change ({ shown, hidden }).
 * Strings: bannerMore, showLess, dismiss.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, safeHref, t } from './core.js';
import { enter, flip } from './motion.js';
import { alert as alertGlyph, alertCircle, checkCircle, close as closeGlyph, iconElement, info } from './icons.js';
import { open as openStore } from './store.js';
import { announce } from './toast.js';

/** The rank of each tone when no priority is given: the more urgent first. */
const TONE_RANK = Object.freeze({ error: 50, warning: 40, info: 30, primary: 20, neutral: 10, success: 0 });

/** The rank of the plain alert (no tone class): the neutral one. */
const PLAIN_RANK = 10;

const TONES = Object.keys(TONE_RANK);

/**
 * The priority of an alert's data: a number given wins; else its tone's
 * rank. Higher comes first.
 * @param {{ priority?: number|string|null, tone?: string|null }} banner
 * @returns {number}
 */
export function priorityOf(banner) {
  const given = Number.parseFloat(String(banner?.priority ?? ''));
  if (Number.isFinite(given)) return given;
  const tone = banner?.tone ? String(banner.tone) : '';
  return Object.hasOwn(TONE_RANK, tone) ? TONE_RANK[tone] : PLAIN_RANK;
}

/**
 * Banners in the order they show: by priorityOf(), the highest first;
 * equal ones keep the given order.
 * @template {{ priority?: number|string|null, tone?: string|null }} B
 * @param {B[]} banners
 * @returns {B[]}
 */
export function order(banners) {
  return banners
    .map((banner, at) => ({ banner, at, rank: priorityOf(banner) }))
    .sort((a, b) => b.rank - a.rank || a.at - b.at)
    .map((entry) => entry.banner);
}

/** The tone of an alert element, from its .ds-tone-* class (else null: the plain alert). */
function toneOf(el) {
  for (const tone of TONES) if (el.classList.contains(`ds-tone-${tone}`)) return tone;
  // The 2.x modifiers, deprecated, still mean their tone.
  for (const tone of ['success', 'warning', 'error']) if (el.classList.contains(`ds-alert--${tone}`)) return tone;
  return null;
}

/** The glyph of a built alert of `tone`. */
const glyphOf = (tone) => (tone === 'error' ? alertCircle : tone === 'warning' ? alertGlyph : tone === 'success' ? checkCircle : info);

/** The storage of the dismissals: localStorage, sessionStorage or memory only. */
function storeFor(el) {
  const view = el.ownerDocument?.defaultView;
  const remember = el.getAttribute('data-ds-banner-remember') ?? 'local';
  if (remember === 'off') return openStore('banner', { storage: null });
  if (remember === 'session') {
    let storage = null;
    try {
      storage = view?.sessionStorage ?? null;
    } catch {
      storage = null;
    }
    return openStore('banner', { storage });
  }
  return openStore('banner');
}

/** Numbers the ids of alerts that need one (the more button's aria-controls). */
let numbered = 0;

function controller(el, given = {}, signal = null) {
  const doc = el.ownerDocument;
  let store = storeFor(el);
  const listeners = new Map();
  const lifetime = new AbortController();
  signal?.addEventListener('abort', () => lifetime.abort(), { once: true });
  let expanded = false;
  let firstPaint = true;
  /** The alerts this controller built from data, by id (they go with set() and destroy()). */
  const built = new Map();

  const fire = (type, detail) => {
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  const maxShown = () => {
    const given = Number.parseInt(el.getAttribute('data-ds-banner-max') ?? '', 10);
    return Number.isInteger(given) && given > 0 ? given : 1;
  };

  const alerts = () => [...el.children].filter((child) => child.classList.contains('ds-alert'));
  const idOf = (alert) => alert.getAttribute('data-ds-banner-id') || '';
  const dismissed = (id) => Boolean(id) && Boolean(store.get(id, false));

  // The more button, after the shown messages.
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'ds-btn ds-btn--text ds-sm ds-banner__more';
  more.setAttribute('aria-expanded', 'false');
  more.hidden = true;

  /** The dismiss button of an alert with an id (unless it has one, or opts out). */
  const ensureDismiss = (alert) => {
    if (!idOf(alert) || alert.getAttribute('data-ds-banner-dismiss') === 'off') return;
    if (alert.querySelector(':scope > .ds-banner__dismiss')) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-banner__dismiss';
    button.setAttribute('aria-label', t('dismiss'));
    button.setAttribute('data-tip', t('dismiss'));
    button.append(iconElement(closeGlyph, 20, undefined, doc));
    alert.append(button);
  };

  /** An alert built from data, in the documented markup. */
  const build = (banner) => {
    const tone = banner.tone && TONES.includes(String(banner.tone)) ? String(banner.tone) : null;
    const alert = doc.createElement('div');
    alert.className = tone ? `ds-alert ds-tone-${tone}` : 'ds-alert';
    // Spoken through the announcers when it shows (add()), so no live role of its own unless the page asks.
    if (banner.role) alert.setAttribute('role', String(banner.role));
    if (banner.id) alert.setAttribute('data-ds-banner-id', String(banner.id));
    if (banner.priority != null) alert.setAttribute('data-ds-banner-priority', String(banner.priority));
    if (banner.dismissible === false) alert.setAttribute('data-ds-banner-dismiss', 'off');
    alert.append(iconElement(banner.icon ?? glyphOf(tone), 20, undefined, doc));
    const text = doc.createElement(banner.title ? 'div' : 'span');
    text.className = 'ds-alert__text';
    if (banner.title) {
      const title = doc.createElement('p');
      title.className = 'ds-alert__title';
      title.textContent = String(banner.title);
      const body = doc.createElement('p');
      body.textContent = String(banner.text ?? '');
      text.append(title);
      if (banner.text) text.append(body);
    } else text.textContent = String(banner.text ?? '');
    alert.append(text);
    const action = banner.action;
    if (action?.label) {
      // An href from data only when safe: a javascript: or data: URL makes a button (its onClick, if any).
      const href = safeHref(action.href);
      const link = doc.createElement(href ? 'a' : 'button');
      link.className = 'ds-btn ds-btn--text ds-sm';
      link.textContent = String(action.label);
      if (href) link.setAttribute('href', href);
      else {
        link.setAttribute('type', 'button');
        link.addEventListener('click', (event) => {
          try {
            action.onClick?.(event, api);
          } catch (error) {
            doc.defaultView?.reportError?.(error);
          }
        }, { signal: lifetime.signal });
      }
      alert.append(link);
    }
    return alert;
  };

  /**
   * Puts the alerts in priority order (moving only those out of place, so
   * focus stays), hides the dismissed ones and those past the maximum
   * while collapsed, and writes the more button.
   */
  const paint = (animate = true) => {
    const all = alerts();
    for (const alert of all) ensureDismiss(alert);
    const sorted = order(all.map((alert) => ({ alert, tone: toneOf(alert), priority: alert.getAttribute('data-ds-banner-priority') }))).map((entry) => entry.alert);
    const live = sorted.filter((alert) => !dismissed(idOf(alert)));
    const limit = maxShown();
    const extra = Math.max(0, live.length - limit);
    if (!extra) expanded = false;
    const shown = new Set(expanded ? live : live.slice(0, limit));
    const appeared = [];
    const change = () => {
      // Order: the sorted alerts first, then the more button.
      let cursor = el.firstElementChild;
      for (const alert of sorted) {
        if (cursor !== alert) el.insertBefore(alert, cursor);
        else cursor = cursor.nextElementSibling;
      }
      if (more.parentNode !== el || more.previousElementSibling !== sorted[sorted.length - 1]) el.append(more);
      for (const alert of sorted) {
        const show = shown.has(alert);
        if (show && alert.hidden) appeared.push(alert);
        alert.hidden = !show;
      }
      more.hidden = extra === 0;
      more.setAttribute('aria-expanded', String(expanded));
      more.textContent = expanded ? t('showLess') : t('bannerMore', { count: extra });
      el.hidden = live.length === 0;
    };
    const parent = el.parentElement;
    if (animate && !firstPaint && parent) flip(parent, change, { items: ':scope > *' });
    else change();
    if (!firstPaint) for (const alert of appeared) enter(alert, 'fade');
    firstPaint = false;
    if (extra) {
      // The more button controls the messages it shows.
      const ids = sorted.map((alert) => {
        if (!alert.id) {
          numbered += 1;
          alert.id = `ds-banner-${numbered}`;
        }
        return alert.id;
      });
      more.setAttribute('aria-controls', ids.join(' '));
    }
    return { shown: [...shown].map(idOf), hidden: sorted.filter((alert) => !shown.has(alert)).map(idOf) };
  };

  const changed = (animate = true) => fire('change', paint(animate));

  /** Where focus goes when a message it was in goes: the next message's dismiss, the more button, the view. */
  const landing = (gone) => {
    const visible = alerts().filter((alert) => !alert.hidden && alert !== gone);
    const after = visible.find((alert) => gone.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING) ?? visible[0];
    const target = after?.querySelector('.ds-banner__dismiss, a[href], button:not([disabled])')
      ?? (!more.hidden ? more : null)
      ?? el.parentElement?.querySelector(':scope > .ds-view')
      ?? el.closest('.ds-app, .ds-theme')?.querySelector('.ds-view')
      ?? null;
    return target;
  };

  const dismiss = (id) => {
    const alert = alerts().find((each) => idOf(each) === id);
    if (!id) return;
    const hadFocus = alert?.contains(doc.activeElement);
    store.set(id, Date.now());
    if (alert && hadFocus) {
      // Focus moves before the message goes, so it never falls to the body.
      const next = landing(alert);
      alert.hidden = true;
      changed();
      if (next) {
        if (next.classList.contains('ds-view') && !next.hasAttribute('tabindex')) next.setAttribute('tabindex', '-1');
        /** @type {HTMLElement} */ (next).focus({ preventScroll: true });
      }
    } else changed();
    fire('dismiss', { id });
  };

  el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.('.ds-banner__more') === more) {
      expanded = !expanded;
      changed();
      return;
    }
    const button = target.closest?.('.ds-banner__dismiss');
    if (!button || !el.contains(button)) return;
    const alert = button.closest('.ds-alert');
    if (alert) dismiss(idOf(alert));
  }, { signal: lifetime.signal });

  // Dismissed in another tab (or restored): this one follows.
  const follow = () => store.on('change', ({ key }) => {
    if (key === null || alerts().some((alert) => idOf(alert) === key)) changed();
  });
  let offStore = follow();

  const add = (banners, speak = false) => {
    const added = [];
    for (const banner of Array.isArray(banners) ? banners : [banners]) {
      if (!banner) continue;
      const id = banner.id ? String(banner.id) : '';
      if (id && built.has(id)) built.get(id).remove();
      const alert = build(banner);
      if (id) built.set(id, alert);
      // Before the more button, so it never moves (and keeps focus).
      el.insertBefore(alert, more.parentNode === el ? more : null);
      added.push({ alert, banner });
    }
    return speak ? added : [];
  };

  /** Says the messages that arrived and show (an urgent one at once), as the page's role would. */
  const say = (added) => {
    for (const { alert, banner } of added) {
      if (alert.hidden || alert.hasAttribute('role')) continue;
      const text = [banner.title, banner.text].filter(Boolean).join('. ');
      if (text) announce(text, { assertive: banner.tone === 'error' });
    }
  };

  if (Array.isArray(given.banners)) add(given.banners);
  changed(false);

  const api = {
    get() {
      return alerts().filter((alert) => !alert.hidden).map(idOf);
    },
    set(banners) {
      for (const alert of built.values()) alert.remove();
      built.clear();
      const added = add(banners ?? [], true);
      changed();
      say(added);
    },
    add(banners) {
      const added = add(banners, true);
      changed();
      say(added);
    },
    remove(id) {
      const alert = alerts().find((each) => idOf(each) === id);
      if (!alert) return;
      if (alert.contains(doc.activeElement)) /** @type {HTMLElement|null} */ (landing(alert))?.focus({ preventScroll: true });
      const parent = el.parentElement;
      const go = () => {
        alert.remove();
        built.delete(id);
      };
      if (parent) flip(parent, go, { items: ':scope > *' });
      else go();
      changed();
    },
    dismiss,
    restore(id) {
      store.remove(id);
      changed();
    },
    expand(on = true) {
      expanded = Boolean(on);
      changed();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    /**
     * A change of data-ds-banner-max or -remember (core calls it): the
     * same controller keeps its messages from data; a new remember swaps
     * the storage of the dismissals.
     */
    update(names = []) {
      if (names.includes('data-ds-banner-remember')) {
        offStore();
        store.destroy();
        store = storeFor(el);
        offStore = follow();
      }
      changed();
    },
    destroy() {
      made.delete(el);
      lifetime.abort();
      offStore();
      store.destroy();
      more.remove();
      for (const alert of built.values()) alert.remove();
      built.clear();
      listeners.clear();
    },
  };
  return api;
}

const made = new WeakMap();

define('banner', {
  attribute: 'data-ds-banner',
  attributes: ['data-ds-banner-max', 'data-ds-banner-remember'],
  init(el, ctx) {
    const known = made.get(el);
    if (known) return known;
    const banner = controller(el, {}, ctx.signal);
    made.set(el, banner);
    const destroy = banner.destroy;
    banner.destroy = () => {
      made.delete(el);
      destroy();
    };
    return banner;
  },
});

/**
 * The controller of a .ds-banner: the same one data-ds-banner makes.
 * `banners` adds messages built from data ({ id, tone, title, text, icon,
 * action: { label, href | onClick }, priority, dismissible, role }). Once
 * per element: a second call returns the same controller with `banners`
 * added.
 * @param {Element} el
 * @param {{ banners?: object[] }} [options]
 */
export function create(el, options = {}) {
  const known = made.get(el);
  if (known) {
    if (options.banners) known.add(options.banners);
    return known;
  }
  const banner = controller(el, options);
  made.set(el, banner);
  return banner;
}
