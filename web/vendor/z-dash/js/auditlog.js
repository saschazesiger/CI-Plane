/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Audit log (3.0): who did what and when, and what changed, rendered from
 * the page's records onto a timeline grouped by day, with a description
 * list of the changed fields (old to new) and filters the page's own
 * controls drive.
 *
 *   <section class="ds-auditlog" aria-label="Audit log" data-ds-auditlog>
 *     <div class="ds-auditlog__filters" role="group" aria-label="Filter the log">
 *       <select class="ds-select" aria-label="Who" data-ds-auditlog-filter="actor"> ... </select>
 *       <input class="ds-input" type="search" aria-label="Search the log" data-ds-auditlog-filter="text">
 *       <p class="ds-auditlog__count"></p>
 *     </div>
 *     <ol class="ds-timeline ds-timeline--activity" role="list" aria-label="Events"></ol>
 *     <div class="ds-empty" data-ds-auditlog-empty hidden> ... </div>
 *     <script type="application/json">[{ "id": "e81", "at": "2026-10-12T14:05", "actor": "Ada Lovelace", ... }]</script>
 *   </section>
 *   const log = DS.auditlog.create(el, { entries, fields: { owner: 'Owner' } });
 *   log.set(newer);                     // live: new entries glide in (DS.motion.flip)
 *   log.filter({ actor: 'ada' });       // the controls follow
 *
 * An entry: { id, at, actor, action, target, source, status, muted, note,
 * changes | before and after, facets }. actor: a name, or { name, initials,
 * image, icon, id }; target: a text or { label, href }; status: { tone,
 * text, icon } (a .ds-status: an icon and a word); changes: [{ field,
 * before, after }], or before and after as objects, which changes() turns
 * into the changed fields (labelled through `fields`). Values that are no
 * text pass through `format(value, path, entry)` (default: numbers through
 * Intl, lists joined, objects as JSON; nothing set says "Not set").
 *
 * Filters: every control in the element with data-ds-auditlog-filter="<name>"
 * (a select, a text or date field, radios, checkboxes that share the name)
 * narrows the entries: "text" searches every word of an entry, "from" and
 * "to" take dates (whole days), any other name compares the entry's
 * facets[name] (else entry[name], an object by its id or name). No value,
 * or no box checked, lets everything through. .ds-auditlog__count shows
 * how many entries show, and a change of the filters announces it.
 *
 * Limit: the first `limit` matching entries (200) draw; a "Show more"
 * button (.ds-auditlog__more, written under the list) draws as many again
 * and takes the focus to the first of them. A change of the filters starts
 * from the limit again. A target's href is kept only when it is relative,
 * a fragment, http(s) or mailto; else the target is text.
 *
 * Events (bubbling, on the element; also through on(type, fn)):
 *   ds:filter  { filters, shown, total }   the filters changed
 *   ds:render  { shown, total }            the entries were drawn again
 *
 * ES2022; no DOM is touched until an element is initialised.
 */
import { define, emit, t } from './core.js';
import { announce } from './a11y.js';
import { morphHtml } from './dom.js';
import { flip, motionDuration } from './motion.js';
import { absolute, number } from './format.js';
import { icon, alertCircle, check, info, alert as alertGlyph, user, sync, globe } from './icons.js';

const DAY = 86400000;
const FILTER = 'data-ds-auditlog-filter';
const TONES = new Set(['neutral', 'primary', 'info', 'success', 'warning', 'error']);
const TONE_GLYPHS = { success: check, error: alertCircle, warning: alertGlyph, info, primary: info, neutral: info };
/** The glyphs an actor that is no person may take (actor.icon): a sync, a person unnamed, the web. */
const ACTOR_GLYPHS = { sync, user, globe };

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const isUnset = (value) => value === undefined || value === null || value === '';
/** How many entries draw at first, and how many more each "Show more" adds. */
const LIMIT = 200;

/**
 * `href` when it is safe to put in a link: relative, a fragment, http(s) or
 * mailto. Anything else (javascript:, data:, a scheme hidden by tabs or
 * spaces, which the URL parser drops) is null: the label shows as text.
 */
const safeUrl = (href) => {
  const text = String(href ?? '').trim();
  if (!text || typeof URL !== 'function') return null;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(text, 'https://base.invalid/').protocol) ? text : null;
  } catch {
    return null;
  }
};

/* ── Pure helpers: the diff, the days, the filters ─────────────── */

/** Every leaf of `value` by its path (objects and arrays of objects open; a list of plain values is one leaf). */
function leaves(value, prefix, out, ignore) {
  const skip = (path) => ignore.some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`));
  if (prefix && skip(prefix)) return out;
  if (isPlain(value)) {
    const keys = Object.keys(value);
    if (!keys.length && prefix) out.set(prefix, value);
    for (const key of keys) leaves(value[key], prefix ? `${prefix}.${key}` : key, out, ignore);
    return out;
  }
  if (Array.isArray(value) && value.some((item) => isPlain(item) || Array.isArray(item))) {
    if (!value.length && prefix) out.set(prefix, value);
    value.forEach((item, index) => leaves(item, `${prefix}[${index}]`, out, ignore));
    return out;
  }
  if (prefix) out.set(prefix, value);
  return out;
}

/** Two leaves are equal: the same value, the same date, or lists of the same values. */
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (isPlain(a) && isPlain(b)) return !Object.keys(a).length && !Object.keys(b).length;
  return false;
}

/**
 * The fields that differ between two versions of a record, in the order of
 * the new one (then the fields only the old one had): { path, field, before,
 * after, kind }. Nested objects open into dotted paths ("owner.name"), lists
 * of objects into indexed ones ("ports[0].speed"); a list of plain values is
 * one field. `fields` labels a path (else the path is the label); `ignore`
 * leaves paths out (with what lies under them).
 * @param {unknown} before
 * @param {unknown} after
 * @param {{ fields?: Record<string, string>, ignore?: string[] }} [options]
 * @returns {Array<{ path: string, field: string, before: unknown, after: unknown, kind: 'added'|'removed'|'changed' }>}
 */
export function changes(before, after, options = {}) {
  const ignore = options.ignore ?? [];
  const old = leaves(before ?? {}, '', new Map(), ignore);
  const now = leaves(after ?? {}, '', new Map(), ignore);
  const out = [];
  const add = (path, a, b) => {
    if (same(a, b) || (isUnset(a) && isUnset(b))) return;
    const kind = isUnset(a) ? 'added' : isUnset(b) ? 'removed' : 'changed';
    out.push({ path, field: options.fields?.[path] ?? path, before: a, after: b, kind });
  };
  for (const [path, value] of now) add(path, old.get(path), value);
  for (const [path, value] of old) if (!now.has(path)) add(path, value, undefined);
  return out;
}

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** One day formatter per time zone, made once: a log of thousands of entries asks for thousands of days. */
const dayFormats = new Map();

/** The calendar day of `date` in `timeZone` (default: the page's): "2026-10-12". */
function dayKey(date, timeZone) {
  const zone = timeZone ?? '';
  let made = dayFormats.get(zone);
  if (!made) {
    made = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
    if (dayFormats.size >= 32) dayFormats.clear();
    dayFormats.set(zone, made);
  }
  const parts = made.formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The entries with their dates in the order they show: newest first (or oldest), the undated last. */
function sorted(entries, order) {
  const sign = order === 'oldest' ? 1 : -1;
  const timed = (entries ?? []).map((entry, index) => ({ entry, index, date: toDate(entry?.at) }));
  timed.sort((a, b) => {
    if (!a.date || !b.date) return (a.date ? -1 : b.date ? 1 : 0) || a.index - b.index;
    return sign * (a.date.getTime() - b.date.getTime()) || a.index - b.index;
  });
  return timed;
}

/**
 * The entries by calendar day, newest day first (`order: 'oldest'` turns
 * days and entries round): [{ key: '2026-10-12', label, entries }]. Today
 * and yesterday are named ("Today", "Yesterday"), other days written out
 * through Intl. An entry without a valid `at` goes last, in a day of its
 * own with an empty key. `now`, `locale` and `timeZone` for the page.
 * @param {Array<{ at?: Date|number|string }>} entries
 * @param {{ now?: Date|number, locale?: string, timeZone?: string, order?: 'newest'|'oldest' }} [options]
 * @returns {Array<{ key: string, label: string, entries: any[] }>}
 */
export function group(entries, options = {}) {
  const timeZone = options.timeZone;
  const now = toDate(options.now ?? Date.now());
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(new Date(now.getTime() - DAY), timeZone);
  const timed = sorted(entries, options.order);
  const days = [];
  for (const { entry, date } of timed) {
    const key = date ? dayKey(date, timeZone) : '';
    let day = days.at(-1);
    if (!day || day.key !== key) {
      const label = !date ? t('auditlogUndated')
        : key === today ? t('auditlogToday')
          : key === yesterday ? t('auditlogYesterday')
            : absolute(date, { locale: options.locale, timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      day = { key, label, entries: [] };
      days.push(day);
    }
    day.entries.push(entry);
  }
  return days;
}

/** What a facet of an entry is, as text: an object by its id, else its name or label. */
const facetOf = (entry, name) => {
  const value = entry?.facets && Object.hasOwn(entry.facets, name) ? entry.facets[name] : entry?.[name];
  if (isPlain(value)) return String(value.id ?? value.name ?? value.label ?? '');
  if (Array.isArray(value)) return value.map(String);
  return isUnset(value) ? '' : String(value);
};

const fold = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Every word an entry shows, for the text filter. */
function wordsOf(entry, format) {
  const words = [];
  const named = (value) => (isPlain(value) ? value.name ?? value.label ?? '' : value ?? '');
  words.push(named(entry.actor), entry.action ?? '', named(entry.target), entry.source ?? '', entry.note ?? '', entry.status?.text ?? '');
  for (const change of entryChanges(entry)) words.push(change.field, valueText(change.before, change.path, entry, format), valueText(change.after, change.path, entry, format));
  return fold(words.join(' '));
}

/**
 * Whether an entry passes `filters` ({ name: value }): "text" (every word
 * of it somewhere in the entry, without case or accents), "from" and "to"
 * (whole days, inclusive), any other name the entry's facet (one value, or
 * any of a list). An empty value or list lets everything through.
 * @param {object} entry
 * @param {Record<string, string|string[]|null|undefined>} filters
 * @param {{ timeZone?: string, format?: (value: unknown, path: string, entry: object) => string }} [options]
 * @returns {boolean}
 */
export function matches(entry, filters = {}, options = {}) {
  return matcher(filters, options)(entry);
}

/**
 * The test of matches() for many entries: the filters read once, the words
 * of each entry kept in `words` (a WeakMap the controller holds until its
 * entries or options change), so typing does not rebuild them per key.
 */
function matcher(filters, options = {}, words = null) {
  const tests = [];
  for (const [name, wanted] of Object.entries(filters ?? {})) {
    const values = (Array.isArray(wanted) ? wanted : [wanted]).filter((value) => !isUnset(value)).map(String);
    if (!values.length) continue;
    if (name === 'text') {
      const wantedWords = values.map((value) => fold(value).split(/\s+/).filter(Boolean));
      tests.push((entry) => {
        let text = words?.get(entry);
        if (text === undefined) {
          text = wordsOf(entry, options.format);
          if (words && entry && typeof entry === 'object') words.set(entry, text);
        }
        return wantedWords.every((list) => list.every((word) => text.includes(word)));
      });
      continue;
    }
    if (name === 'from' || name === 'to') {
      tests.push((entry) => {
        const date = toDate(entry?.at);
        if (!date) return false;
        const day = dayKey(date, options.timeZone);
        return name === 'from' ? day >= values[0] : day <= values[0];
      });
      continue;
    }
    tests.push((entry) => {
      const facet = facetOf(entry, name);
      return Array.isArray(facet) ? facet.some((value) => values.includes(value)) : values.includes(facet);
    });
  }
  return (entry) => tests.every((test) => test(entry));
}

/* ── Rendering ─────────────────────────────────────────────────── */

function entryChanges(entry) {
  if (Array.isArray(entry?.changes)) return entry.changes.map((change) => ({ path: change.path ?? change.field, field: change.field ?? change.path, before: change.before, after: change.after }));
  if (entry && ('before' in entry || 'after' in entry)) return changes(entry.before, entry.after, { fields: entry.fields });
  return [];
}

function valueText(value, path, entry, format) {
  if (typeof format === 'function') {
    const own = format(value, path, entry);
    if (own !== undefined && own !== null) return String(own);
  }
  if (isUnset(value)) return '';
  if (typeof value === 'number') return number(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return absolute(value);
  if (Array.isArray(value)) return value.map((item) => valueText(item, path, entry)).join(', ');
  if (isPlain(value)) return JSON.stringify(value);
  return String(value);
}

function sideHtml(value, path, entry, format, kind) {
  const text = valueText(value, path, entry, format);
  const word = kind === 'old' ? t('auditlogBefore') : t('auditlogAfter');
  const shown = text === '' ? `<span class="ds-auditlog__none">${esc(t('auditlogNotSet'))}</span>`
    : kind === 'old' ? `<del>${esc(text)}</del>` : `<ins>${esc(text)}</ins>`;
  return `<dd class="ds-auditlog__${kind}"><span class="ds-sr">${esc(word)} </span>${shown}</dd>`;
}

function markerHtml(actor) {
  if (isPlain(actor) && actor.image) return `<img src="${esc(actor.image)}" alt="">`;
  if (isPlain(actor) && actor.icon && ACTOR_GLYPHS[actor.icon]) return icon(ACTOR_GLYPHS[actor.icon], 16);
  const name = isPlain(actor) ? actor.name ?? '' : actor ?? '';
  const initials = isPlain(actor) && actor.initials ? actor.initials
    : String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase();
  return initials ? esc(initials) : icon(user, 16);
}

function statusHtml(status) {
  if (!status?.text) return '';
  const tone = TONES.has(status.tone) ? status.tone : 'neutral';
  return `<span class="ds-status ds-tone-${tone}">${icon(TONE_GLYPHS[tone], 16)}<span>${esc(status.text)}</span></span>`;
}

function entryHtml(entry, settings) {
  const date = toDate(entry.at);
  const actor = entry.actor;
  const name = isPlain(actor) ? actor.name ?? '' : actor ?? '';
  const target = entry.target;
  const label = isPlain(target) ? target.label ?? '' : target ?? '';
  const href = isPlain(target) ? safeUrl(target.href) : null;
  const targetHtml = !label ? '' : href ? ` <a href="${esc(href)}">${esc(label)}</a>` : ` ${esc(label)}`;
  const time = date ? `<time class="ds-timeline__time" datetime="${esc(date.toISOString())}" title="${esc(absolute(date, { locale: settings.locale, timeZone: settings.timeZone, dateStyle: 'full', timeStyle: 'medium' }))}">${esc(absolute(date, { locale: settings.locale, timeZone: settings.timeZone, timeStyle: 'short' }))}</time>` : '';
  const list = entryChanges(entry);
  const diff = list.length
    ? `<dl class="ds-auditlog__diff">${list.map((change) => `<div class="ds-auditlog__change"><dt>${esc(change.field)}</dt>${sideHtml(change.before, change.path, entry, settings.format, 'old')}${sideHtml(change.after, change.path, entry, settings.format, 'new')}</div>`).join('')}</dl>`
    : '';
  const source = entry.source ? `<p class="ds-auditlog__source">${esc(entry.source)}</p>` : '';
  const note = entry.note ? `<p class="ds-timeline__text">${esc(entry.note)}</p>` : '';
  const key = entry.id ?? `${entry.at ?? ''}|${name}|${entry.action ?? ''}`;
  return `<li class="ds-timeline__item ds-timeline__item--icon${entry.muted ? ' ds-timeline__item--muted' : ''}" data-ds-key="${esc(key)}">`
    + `<span class="ds-timeline__marker" aria-hidden="true">${markerHtml(actor)}</span>`
    + `<div class="ds-timeline__head"><p class="ds-timeline__title"><strong>${esc(name)}</strong> ${esc(entry.action ?? '')}${targetHtml}</p>${statusHtml(entry.status)}${time}</div>`
    + `${source}${diff}${note}</li>`;
}

/** The timeline's markup of `entries` (in the order they show), by day: what create() draws. */
function logHtml(entries, settings) {
  return group(entries, settings).map((day) => `<li class="ds-timeline__group" role="presentation" data-ds-key="day-${esc(day.key)}"><h3 class="ds-timeline__day">${esc(day.label)}</h3></li>`
    + day.entries.map((entry) => entryHtml(entry, settings)).join('')).join('');
}

/* ── The controller ────────────────────────────────────────────── */

const logs = new WeakMap();

/** The entries of a <script type="application/json"> inside the element, else []. */
function sourceEntries(el) {
  const script = el.querySelector(':scope > script[type="application/json"]');
  if (!script) return [];
  try {
    const value = JSON.parse(script.textContent ?? '');
    return Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  } catch {
    return [];
  }
}

function controller(el, initial) {
  const doc = el.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  let settings = { ...initial };
  let entries = Array.isArray(initial.entries) ? initial.entries.slice() : sourceEntries(el);
  let shown = 0;
  /** The words of each entry for the text filter, until the entries or the options change. */
  let words = new WeakMap();
  const limitOf = () => {
    const value = Number(settings.limit ?? LIMIT);
    return value > 0 ? Math.floor(value) : Infinity;
  };
  /** How many matching entries draw: the limit, a limit more per "Show more". */
  let room = limitOf();

  const list = () => el.querySelector(':scope > .ds-timeline, :scope > * > .ds-timeline');
  const controls = () => Array.from(el.querySelectorAll(`[${FILTER}]`)).filter((control) => control.closest('.ds-auditlog') === el);

  /** The filters the controls hold now. */
  const read = () => {
    const out = {};
    for (const control of controls()) {
      const name = control.getAttribute(FILTER);
      if (!name) continue;
      if (control.type === 'checkbox') {
        out[name] = Array.isArray(out[name]) ? out[name] : [];
        if (control.checked) out[name].push(control.value);
      } else if (control.type === 'radio') {
        if (control.checked) out[name] = control.value;
        else if (!(name in out)) out[name] = '';
      } else if (control.localName === 'select' && control.multiple) {
        out[name] = Array.from(control.selectedOptions, (option) => option.value);
      } else {
        out[name] = control.value ?? '';
      }
    }
    return { ...settings.filters, ...out };
  };
  let filters = read();

  /** Puts `values` into the controls. */
  const write = (values) => {
    for (const control of controls()) {
      const name = control.getAttribute(FILTER);
      if (!name || !(name in values)) continue;
      const wanted = values[name];
      const list = (Array.isArray(wanted) ? wanted : [wanted]).filter((value) => !isUnset(value)).map(String);
      if (control.type === 'checkbox' || control.type === 'radio') control.checked = list.includes(control.value);
      else if (control.localName === 'select' && control.multiple) for (const option of control.options) option.selected = list.includes(option.value);
      else control.value = list[0] ?? '';
    }
  };

  const active = () => Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : !isUnset(value)));

  const countText = () => {
    const total = entries.length;
    if (!active()) return t(total === 1 ? 'auditlogEvent' : 'auditlogEvents', { count: number(total) });
    return t('auditlogFiltered', { shown: number(shown), total: number(total) });
  };

  /** The "Show more" button under the list while matching entries wait past the limit; gone without. */
  let button = null;
  const more = (target, left) => {
    if (left <= 0) {
      button?.remove();
      return;
    }
    if (!button) {
      button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ds-btn ds-btn--outlined ds-auditlog__more';
      button.addEventListener('click', showMore, { signal });
    }
    if (button.previousElementSibling !== target) target.after(button);
    button.textContent = t('auditlogMore', { count: number(Math.min(left, limitOf())) });
  };

  const draw = (animate) => {
    const target = list();
    if (!target) return Promise.resolve();
    const visible = entries.filter(matcher(filters, settings, words));
    shown = visible.length;
    // Past the limit only the first entries in the order they show draw.
    const drawn = visible.length > room ? sorted(visible, settings.order).slice(0, room).map((each) => each.entry) : visible;
    const html = logHtml(drawn, settings);
    const done = animate ? flip(target, (options) => morphHtml(target, html, options), { live: settings.live !== false }) : (morphHtml(target, html), Promise.resolve());
    more(target, shown - drawn.length);
    // Nothing to show: the list goes (an empty list is no list), the page's empty state shows.
    target.hidden = shown === 0;
    for (const empty of el.querySelectorAll('[data-ds-auditlog-empty]')) empty.hidden = shown !== 0;
    for (const count of el.querySelectorAll('.ds-auditlog__count')) count.textContent = countText();
    emit(el, 'render', { shown, total: entries.length });
    return done;
  };

  /** The next entries past the limit; the focus goes to the first of them, where reading goes on. */
  function showMore() {
    const target = list();
    if (!target) return;
    const before = target.querySelectorAll(':scope > .ds-timeline__item').length;
    room += limitOf();
    draw(false);
    const first = target.querySelectorAll(':scope > .ds-timeline__item')[before];
    if (first) {
      first.tabIndex = -1;
      first.focus();
    }
  }

  const refilter = () => {
    const next = read();
    if (JSON.stringify(next) === JSON.stringify(filters)) return;
    filters = next;
    room = limitOf();
    draw(false);
    announce(shown === 0 ? t('noResults') : countText(), { key: 'auditlog-count' });
    emit(el, 'filter', { filters: { ...filters }, shown, total: entries.length });
  };

  // Typing waits for a pause (--ds-dur-fast); a choice applies at once.
  let typing = 0;
  const later = (wait) => {
    doc.defaultView?.clearTimeout(typing);
    typing = doc.defaultView?.setTimeout(refilter, wait) ?? 0;
  };
  el.addEventListener('input', (event) => {
    const control = event.target;
    if (!control?.hasAttribute?.(FILTER)) return;
    if (control.type === 'checkbox' || control.type === 'radio' || control.localName === 'select') refilter();
    else later(motionDuration(el, '--ds-dur-fast'));
  }, { signal });
  el.addEventListener('change', (event) => {
    if (!event.target?.hasAttribute?.(FILTER)) return;
    doc.defaultView?.clearTimeout(typing);
    refilter();
  }, { signal });
  // A form of filters resets: the controls change after the event.
  el.addEventListener('reset', () => later(0), { signal });

  draw(false);

  const handle = {
    /** The entries, all of them (also those the filters hide). */
    get() {
      return entries.slice();
    },
    /** New entries: what changed glides (DS.motion.flip; a live log holds while it is pointed at). */
    set(value) {
      entries = Array.isArray(value) ? value.slice() : [];
      words = new WeakMap();
      return draw(true);
    },
    /** The filters now, or new ones (the controls follow); returns the filters. */
    filter(values) {
      if (values && typeof values === 'object') {
        write(values);
        // Kept under the controls: a name no control holds stays set when the user changes another filter.
        settings.filters = { ...settings.filters, ...values };
        filters = { ...read(), ...values };
        room = limitOf();
        draw(false);
        emit(el, 'filter', { filters: { ...filters }, shown, total: entries.length });
      }
      return { ...filters };
    },
    /** How many entries show. */
    count() {
      return { shown, total: entries.length };
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === el) fn(event.detail);
      };
      el.addEventListener(`ds:${type}`, listener, { signal });
      return () => el.removeEventListener(`ds:${type}`, listener);
    },
    /** New options (fields, format, locale, timeZone, now, order, live, limit); draws again. */
    configure(next = {}) {
      settings = { ...settings, ...next };
      if (Array.isArray(next.entries)) entries = next.entries.slice();
      words = new WeakMap();
      room = limitOf();
      filters = read();
      draw(false);
    },
    /** Reads the controls and the JSON source again. */
    update() {
      if (!Array.isArray(settings.entries)) entries = sourceEntries(el);
      words = new WeakMap();
      filters = read();
      draw(false);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      doc.defaultView?.clearTimeout(typing);
      button?.remove();
      if (logs.get(el) === handle) logs.delete(el);
    },
  };
  logs.set(el, handle);
  return handle;
}

define('auditlog', {
  attribute: 'data-ds-auditlog',
  init(el) {
    return logs.get(el) ?? controller(el, {});
  },
});

/**
 * An audit log drawn from the page's records, or new options for one the
 * attribute path made: the same controller. `entries` (else the JSON in a
 * <script type="application/json"> inside the element), `fields` (labels
 * of the paths of before and after), `format(value, path, entry)`,
 * `filters` (the start, under what the controls hold), `locale`,
 * `timeZone`, `now`, `order` ('newest' or 'oldest'), `live` (default
 * true: set() holds a reorder while the log is pointed at) and `limit`
 * (default 200, 0 for all: how many entries draw before "Show more").
 * @param {Element} el
 * @param {{ entries?: object[], fields?: Record<string, string>, format?: (value: unknown, path: string, entry: object) => string|undefined, filters?: Record<string, string|string[]>, locale?: string, timeZone?: string, now?: Date|number, order?: 'newest'|'oldest', live?: boolean, limit?: number }} [options]
 */
export function create(el, options = {}) {
  if (!el?.ownerDocument) return { get: () => [], set: () => Promise.resolve(), filter: () => ({}), count: () => ({ shown: 0, total: 0 }), on: () => () => {}, configure() {}, update() {}, destroy() {} };
  const existing = logs.get(el);
  if (existing) {
    existing.configure(options);
    return existing;
  }
  return controller(el, options);
}
