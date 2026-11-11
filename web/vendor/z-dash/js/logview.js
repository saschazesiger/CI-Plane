/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Log viewer (DS.logview): a long, growing log (a device's output, a build,
 * a job) with only the lines near the viewport in the page, so 100,000 lines
 * scroll as lightly as 100. Lines keep their ANSI colours (mapped to theme
 * roles), show their level as an icon and a word, and can be filtered by
 * level, searched, wrapped, copied one or many at a time, and followed as
 * they arrive.
 *
 *   <div class="ds-logview" data-ds-logview aria-label="Device log">
 *     <pre class="ds-logview__source">2026-11-04T09:00:01Z INFO Device started ...</pre>
 *   </div>
 *   const log = DS.logview.create(el, { follow: true, limit: 100000 });
 *   log.append('09:00:02 WARN Battery at 15%');       // text, or a list of lines or { text, level, time }
 *   log.set({ query: 'timeout', levels: ['error', 'warn'], wrap: true });
 *   log.get();  log.copy();  log.find('next');  log.latest();  log.clear();
 *   DS.logview.parse(line);   one line as data: { time, level, text, segments }
 *   DS.logview.ansi(text);    the ANSI colour runs of a text
 *
 * The attribute path reads the text of .ds-logview__source (kept in the
 * page and hidden once rendered, so the log reads as text before the script
 * runs; a re-render that adds lines to it appends them, one that changes it
 * otherwise starts again) and the options data-ds-logview-follow ("off":
 * no following, no "Latest" pill), data-ds-logview-wrap (present: lines
 * wrap), data-ds-logview-time ("off": no timestamps, "full": the stamp as
 * written; default the time of day), data-ds-logview-limit (lines kept,
 * the oldest go first; default 100000, 0: no limit), data-ds-logview-tools
 * ("off": no tool bar; the API still works) and data-ds-logview-store (a
 * DS.store namespace that remembers wrap and timestamps).
 *
 * What it renders (the component's own; the page writes none of it): a tool
 * bar (.ds-logview__bar: the search with its count and previous and next,
 * "only matching lines", the level filter chips with their counts, wrap,
 * timestamps and copy), the scroller (.ds-logview__scroller) with the
 * listbox of lines (DS.virtual: one tab stop, the arrow keys) and the
 * "Latest" pill (.ds-jump with a .ds-presence, DS.dom.followEnd()).
 *
 * Lines: a timestamp at the start (ISO 8601, a time of day, a syslog date;
 * bracketed or not) and a level after it ([ERROR], ERROR, error:, or
 * level=error / "level":"error" anywhere) are read off the text; a line
 * with neither continues the line before it (a stack trace): it takes its
 * level for the filter and its tint, without an icon of its own. A carriage
 * return keeps what came after it (a progress bar that redrew itself).
 *
 * Selection (copy a line or a range): a click selects one line, Shift+click
 * a range, Ctrl or Cmd+click one more; Space, Shift+arrows, Shift+Space and
 * Ctrl+A on the keyboard (the APG multi-select listbox). Ctrl+C or the copy
 * button copies the selected lines that show (else the active one) as plain
 * text, without the ANSI codes; a text selection of the page's own wins.
 *
 * A page that re-renders around the view with DS.dom.morphHtml keeps it:
 * the bar and the scroller carry data-ds-keep, and the source's `hidden`
 * and the element's data-wrap and data-time are owned state. A change of
 * data-ds-logview-wrap, -time, -limit, -follow, -tools or aria-label applies
 * that option alone (the reader's wrap and timestamps stay otherwise);
 * data-ds-logview-store is read once, when the view starts.
 *
 * Events on the element: ds:change { query, levels, wrap, time, shown,
 * count } after a filter, the search or a view option changed; ds:select
 * { lines } (the line numbers) after the selection changed; ds:copy
 * { text, count } after a copy.
 *
 * ES2022. Progressive: none (navigator.clipboard is checked before use).
 */
import { define, emit, runtime, t } from './core.js';
import { followEnd, morphHtml, own, disown } from './dom.js';
import { announce } from './a11y.js';
import { number, absolute } from './format.js';
import { open as openStore } from './store.js';
import { create as windowRows } from './virtual.js';
import { icon, search, chevronUp, chevronDown, filter, wrapText, clock, copy as copyGlyph, arrowDown, check, octagonAlert, circleX, alert as alertGlyph, info, bug, circleDot } from './icons.js';

/** The page-wide state: the numbering of ids. */
const shared = runtime.state('logview', () => ({ ids: 0 }));

/** Lines kept by default; the oldest go first. */
const LIMIT = 100000;

/** The levels, most severe first: their icon and the string of their word. */
const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const LEVEL_ICON = { fatal: octagonAlert, error: circleX, warn: alertGlyph, info, debug: bug, trace: circleDot };
const LEVEL_WORD = { fatal: 'logFatal', error: 'logError', warn: 'logWarn', info: 'logInfo', debug: 'logDebug', trace: 'logTrace' };

/** The words a log names its levels by. */
const LEVEL_NAMES = {
  fatal: 'fatal', crit: 'fatal', critical: 'fatal', panic: 'fatal', emerg: 'fatal', emergency: 'fatal', alert: 'fatal',
  error: 'error', err: 'error', severe: 'error',
  warn: 'warn', warning: 'warn',
  info: 'info', information: 'info', informational: 'info', notice: 'info',
  debug: 'debug', dbg: 'debug', fine: 'debug',
  trace: 'trace', verbose: 'trace', finest: 'trace',
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (char) => ESCAPES[char]);

/* ── ANSI ───────────────────────────────────────────── */

/** The eight colours of a terminal; the bright ones take the same names (and roles). */
const COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** The xterm palette of the 16 colours, to map 256 and true colours to the nearest. */
const PALETTE = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** The name of the colour of the 16 nearest to `rgb`. */
function nearest(rgb) {
  let best = 0;
  let distance = Infinity;
  PALETTE.forEach((each, index) => {
    const next = (each[0] - rgb[0]) ** 2 + (each[1] - rgb[1]) ** 2 + (each[2] - rgb[2]) ** 2;
    if (next < distance) [best, distance] = [index, next];
  });
  return COLOURS[best % 8];
}

/** The colour name of 256-colour index `n`. */
function indexed(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return COLOURS[n % 8];
  if (n >= 232) {
    const grey = 8 + (n - 232) * 10;
    return nearest([grey, grey, grey]);
  }
  const cube = n - 16;
  const step = (value) => (value ? 55 + value * 40 : 0);
  return nearest([step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6)]);
}

// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001b\[([0-9;:]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

const PLAIN = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false });

/** The style after the SGR parameters `params` (a list of numbers, ; or : separated). */
function sgr(style, params) {
  const next = { ...style };
  const codes = params.length ? params : [0];
  for (let at = 0; at < codes.length; at += 1) {
    const code = codes[at];
    if (code === 0) Object.assign(next, PLAIN);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) [next.bold, next.dim] = [false, false];
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = COLOURS[code - 30];
    else if (code >= 90 && code <= 97) next.fg = COLOURS[code - 90];
    else if (code >= 40 && code <= 47) next.bg = COLOURS[code - 40];
    else if (code >= 100 && code <= 107) next.bg = COLOURS[code - 100];
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      let colour = null;
      if (codes[at + 1] === 5) {
        colour = indexed(codes[at + 2]);
        at += 2;
      } else if (codes[at + 1] === 2) {
        colour = nearest([codes[at + 2] ?? 0, codes[at + 3] ?? 0, codes[at + 4] ?? 0]);
        at += 4;
      }
      if (code === 38) next.fg = colour;
      else next.bg = colour;
    }
  }
  return next;
}

const sameStyle = (a, b) => Object.keys(PLAIN).every((key) => a[key] === b[key]);

/**
 * The runs of a text with ANSI escapes: a list of `{ text, fg, bg, bold,
 * dim, italic, underline, strike, inverse }`, fg and bg a colour name
 * (black, red, green, yellow, blue, magenta, cyan, white; the bright
 * colours, 256 colours and true colours take the nearest of the eight) or
 * null. SGR sets the style; every other escape (cursor moves, titles) is
 * dropped. The texts joined are the plain text.
 * @param {string} text
 * @returns {Array<{ text: string, fg: string|null, bg: string|null, bold: boolean, dim: boolean, italic: boolean, underline: boolean, strike: boolean, inverse: boolean }>}
 */
export function ansi(text) {
  const source = String(text ?? '');
  const runs = [];
  let style = PLAIN;
  let at = 0;
  const push = (part) => {
    if (!part) return;
    const last = runs.at(-1);
    if (last && sameStyle(last, style)) last.text += part;
    else runs.push({ text: part, ...style });
  };
  for (const match of source.matchAll(ESCAPE)) {
    push(source.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[2] === 'm') style = sgr(style, match[1] ? match[1].split(/[;:]/).map((part) => (part === '' ? 0 : Number(part))) : []);
  }
  push(source.slice(at));
  return runs;
}

/** The runs from character `from` of their plain text on. */
function runsFrom(runs, from) {
  if (!from) return runs;
  const out = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    if (end > from) out.push(at >= from ? run : { ...run, text: run.text.slice(from - at) });
    at = end;
  }
  return out;
}

/* ── Lines ──────────────────────────────────────────── */

const STAMP = /^\[?((?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?|[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2})\]?(?:\s+|$)/;
const LEVEL_AT_START = /^(?:\[([A-Za-z]+)\]|<([A-Za-z]+)>|([A-Za-z]+):|([A-Z]+)\b)\s*/;
const LEVEL_FIELD = /(?:^|[\s{,])"?(?:level|lvl|severity)"?\s*[=:]\s*"?([A-Za-z]+)/i;

/** The level a word names, or null. */
const levelOf = (word) => (word ? LEVEL_NAMES[String(word).toLowerCase()] ?? null : null);

/**
 * One line of a log as data: `{ time, level, text, segments }`. `time` is
 * the stamp at its start as written (null without one), `level` one of
 * fatal, error, warn, info, debug, trace (or null), `text` the message
 * without the stamp, the level word and the ANSI escapes, and `segments`
 * its ANSI runs (ansi()). A level that is a field (level=error,
 * "level":"error") stays in the text.
 * @param {string} line
 * @returns {{ time: string|null, level: string|null, text: string, segments: ReturnType<typeof ansi> }}
 */
export function parse(line) {
  let source = String(line ?? '').replace(/\n$/, '');
  // A carriage return redraws the line: what came after the last one shows.
  const back = source.replace(/\r+$/, '').lastIndexOf('\r');
  if (back >= 0) source = source.slice(back + 1).replace(/\r+$/, '');
  const runs = ansi(source);
  const plain = runs.map((run) => run.text).join('');
  let at = 0;
  let time = null;
  let level = null;
  const lead = plain.length - plain.trimStart().length;
  const stamp = STAMP.exec(plain.slice(lead));
  if (stamp) {
    time = stamp[1];
    at = lead + stamp[0].length;
  }
  const word = LEVEL_AT_START.exec(plain.slice(at));
  // A level word counts when it cannot be a sentence: bracketed, upper case or followed by a colon.
  const named = word && levelOf(word[1] ?? word[2] ?? word[3] ?? word[4]);
  if (named && (word[1] || word[2] || word[3] || word[4])) {
    level = named;
    at += word[0].length;
  }
  if (!level) level = levelOf(LEVEL_FIELD.exec(plain)?.[1]);
  const segments = runsFrom(runs, at);
  return { time, level, text: plain.slice(at), segments };
}

/** The time of day of a stamp as written (09:00:01.123), or the stamp. */
function timeOfDay(stamp) {
  return /\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?/.exec(stamp)?.[0] ?? stamp;
}

/* ── The controller ─────────────────────────────────── */

function readOptions(el) {
  const limit = el.getAttribute('data-ds-logview-limit');
  const time = el.getAttribute('data-ds-logview-time');
  return {
    follow: el.getAttribute('data-ds-logview-follow') !== 'off',
    wrap: el.hasAttribute('data-ds-logview-wrap') && el.getAttribute('data-ds-logview-wrap') !== 'off',
    time: time === 'off' ? 'off' : time === 'full' ? 'full' : 'time',
    limit: limit === null || limit === '' ? undefined : Math.max(0, Number(limit) || 0),
    tools: el.getAttribute('data-ds-logview-tools') !== 'off',
    store: el.getAttribute('data-ds-logview-store') || null,
  };
}

const quiet = (act, glyph, label, pressed) => `<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-ds-logview-act="${act}" aria-label="${esc(label)}" data-tip="${esc(label)}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${icon(glyph, 20)}</button>`;

function controller(el, start, outer) {
  const doc = el.ownerDocument;
  const life = new AbortController();
  outer?.addEventListener('abort', () => life.abort(), { once: true });
  const { signal } = life;
  const listeners = { change: new Set(), select: new Set(), copy: new Set() };
  shared.ids += 1;
  const id = `ds-logview-${shared.ids}`;
  const source = start.fromSource ? el.querySelector(':scope > .ds-logview__source') : null;
  const prefs = start.store ? openStore(start.store) : null;

  const state = {
    follow: start.follow !== false,
    wrap: Boolean(prefs?.get('wrap', start.wrap) ?? start.wrap),
    time: prefs?.get('time', start.time) ?? start.time ?? 'time',
    limit: start.limit === undefined ? LIMIT : start.limit,
    tools: start.tools !== false,
    query: '',
    only: false,
    hidden: new Set(),
  };
  if (!['off', 'full', 'time'].includes(state.time)) state.time = 'time';

  /** Every line kept, oldest first; `shown` those the filters let through. */
  let entries = [];
  let shown = [];
  let seq = 0;
  let longest = 0;
  let longestTime = 0;
  const counts = new Map();
  /** The lines with a search match: [index in shown, how many]; and the running total before each. */
  let hits = [];
  let hitTotal = 0;
  /** The current match: an index into hits and the match in that line. */
  let current = null;
  /** The selected lines, by their number, and the end a range grows from. */
  const selected = new Set();
  let anchor = null;
  let destroyed = false;
  let sourceText = source?.textContent ?? '';

  /* Ingest. */
  const entryOf = (input) => {
    let parsed;
    let raw;
    if (input && typeof input === 'object') {
      const text = String(input.text ?? input.message ?? '');
      const own = parse(text);
      const given = levelOf(input.level);
      const when = input.time;
      const dated = typeof when === 'number' || when instanceof Date;
      const stamp = when === undefined || when === null || when === '' ? own.time
        : dated ? absolute(when, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : String(when);
      parsed = { ...own, level: given ?? own.level, time: stamp, clock: dated ? absolute(when, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null };
      // The copy reads as the line would in a file: its stamp, its level word, its text.
      raw = [stamp, given && !own.level ? given.toUpperCase() : null, ansi(text).map((run) => run.text).join('')].filter(Boolean).join(' ');
    } else {
      parsed = parse(input);
      raw = ansi(String(input ?? '').replace(/\r+$/, '').split('\r').pop()).map((run) => run.text).join('');
    }
    const previous = entries.at(-1);
    const cont = !parsed.time && !parsed.level && Boolean(previous?.level);
    seq += 1;
    const entry = {
      seq,
      time: parsed.time,
      clock: parsed.clock ?? null,
      level: cont ? previous.level : parsed.level,
      cont,
      text: parsed.text,
      lower: parsed.text.toLowerCase(),
      segments: parsed.segments,
      raw,
    };
    longest = Math.max(longest, entry.text.length);
    longestTime = Math.max(longestTime, timeText(entry).length);
    if (entry.level) counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
    return entry;
  };

  const timeText = (entry) => {
    if (!entry.time) return '';
    if (state.time === 'full') return entry.time;
    return entry.clock ?? timeOfDay(entry.time);
  };

  const passes = (entry) => (!entry.level || !state.hidden.has(entry.level)) && (!state.only || !state.query || entry.lower.includes(state.query));

  const matchCount = (entry) => {
    if (!state.query || entry.lower.length !== entry.text.length) return 0;
    let count = 0;
    for (let at = entry.lower.indexOf(state.query); at >= 0; at = entry.lower.indexOf(state.query, at + state.query.length)) count += 1;
    return count;
  };

  const addHit = (index) => {
    const count = matchCount(shown[index]);
    if (count) {
      hits.push([index, count, hitTotal]);
      hitTotal += count;
    }
  };

  /** The filters and the search again, over every line. */
  const refilter = () => {
    shown = entries.filter(passes);
    hits = [];
    hitTotal = 0;
    if (state.query) for (let index = 0; index < shown.length; index += 1) addHit(index);
    current = null;
  };

  const linesOf = (value) => {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    const text = String(value).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  };

  /* The parts. */
  el.setAttribute('data-time', state.time);
  if (state.wrap) el.setAttribute('data-wrap', '');
  // What the view writes on the page's element is owned state: a re-render keeps it.
  own(el, 'attrs', 'data-time');
  own(el, 'attrs', 'data-wrap');
  const levelChip = (level) => `<label class="ds-chip ds-logview__chip" data-level="${level}"><input class="ds-chip__input" type="checkbox" value="${level}" data-ds-logview-level="${level}" checked><span class="ds-chip__body">${icon(check, 18, 'ds-chip__check')}${icon(LEVEL_ICON[level], 18, 'ds-logview__glyph')}<span>${esc(t(LEVEL_WORD[level]))}</span><span class="ds-logview__tally"></span></span></label>`;
  // The bar and the scroller are the view's own: a morph of the page around them leaves them.
  const bar = doc.createElement('div');
  bar.className = 'ds-logview__bar';
  bar.setAttribute('data-ds-keep', '');
  bar.hidden = !state.tools;
  morphHtml(bar, `<div class="ds-logview__find"><div class="ds-search ds-logview__search">${icon(search, 20)}<input class="ds-input" type="search" data-ds-logview-act="search" aria-label="${esc(t('logSearch'))}" placeholder="${esc(t('logSearchPlaceholder'))}" aria-describedby="${id}-found" aria-keyshortcuts="Control+F" enterkeyhint="search" autocomplete="off" spellcheck="false"></div>`
    + `<span class="ds-logview__found" id="${id}-found"></span>`
    + quiet('previous', chevronUp, t('logPrevious'))
    + quiet('next', chevronDown, t('logNext'))
    + quiet('only', filter, t('logOnlyMatches'), false)
    + `</div><div class="ds-logview__tools">${quiet('wrap', wrapText, t('logWrap'), state.wrap)}${quiet('time', clock, t('logTimestamps'), state.time !== 'off')}${quiet('copy', copyGlyph, t('logCopyLine'))}</div>`
    + `<div class="ds-logview__filters"><fieldset class="ds-chips ds-logview__levels" hidden><legend class="ds-sr">${esc(t('logLevels'))}</legend></fieldset><span class="ds-logview__count" aria-hidden="true"></span></div>`);
  const scroller = doc.createElement('div');
  scroller.className = 'ds-logview__scroller';
  scroller.setAttribute('data-ds-keep', '');
  morphHtml(scroller, `<div class="ds-logview__lines" role="listbox" aria-multiselectable="true" id="${id}-lines"></div><p class="ds-logview__empty" hidden></p><div class="ds-jump"><div class="ds-presence ds-logview__latest" hidden><button class="ds-btn ds-btn--elevated ds-sm" type="button" data-ds-logview-act="latest">${icon(arrowDown, 18)}${esc(t('logLatest'))}</button></div></div>`);
  el.append(bar, scroller);
  const listbox = /** @type {HTMLElement} */ (scroller.firstElementChild);
  const empty = /** @type {HTMLElement} */ (listbox.nextElementSibling);
  const pill = /** @type {HTMLElement} */ (scroller.querySelector('.ds-logview__latest'));
  if (!state.follow) pill.parentElement.hidden = true;
  const field = /** @type {HTMLInputElement} */ (bar.querySelector('input[type="search"]'));
  const found = bar.querySelector('.ds-logview__found');
  const levelsBox = bar.querySelector('.ds-logview__levels');
  const countText = bar.querySelector('.ds-logview__count');
  const button = (act) => /** @type {HTMLButtonElement} */ (bar.querySelector(`[data-ds-logview-act="${act}"]`));

  const name = () => el.getAttribute('aria-label') || t('logName');
  listbox.setAttribute('aria-label', name());

  /* The rows. */
  const textHtml = (entry, index) => {
    const marks = [];
    if (state.query && entry.lower.length === entry.text.length) {
      for (let at = entry.lower.indexOf(state.query); at >= 0; at = entry.lower.indexOf(state.query, at + state.query.length)) marks.push([at, at + state.query.length]);
    }
    const currentMark = current && hits[current.hit]?.[0] === index ? current.k : -1;
    let out = '';
    let at = 0;
    let mark = 0;
    for (const run of entry.segments) {
      const sgrWords = ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse'].filter((key) => run[key]);
      const styled = run.fg || run.bg || sgrWords.length;
      let inner = '';
      let pos = 0;
      const textOf = run.text;
      while (pos < textOf.length) {
        const offset = at + pos;
        while (mark < marks.length && marks[mark][1] <= offset) mark += 1;
        if (mark < marks.length && marks[mark][0] <= offset) {
          const end = Math.min(textOf.length, marks[mark][1] - at);
          inner += `<mark class="ds-logview__match${mark === currentMark ? ' ds-logview__match--current' : ''}">${esc(textOf.slice(pos, end))}</mark>`;
          pos = end;
        } else {
          const next = mark < marks.length ? Math.min(textOf.length, marks[mark][0] - at) : textOf.length;
          inner += esc(textOf.slice(pos, next));
          pos = next;
        }
      }
      out += styled
        ? `<span class="ds-logview__ansi"${run.fg ? ` data-fg="${run.fg}"` : ''}${run.bg ? ` data-bg="${run.bg}"` : ''}${sgrWords.length ? ` data-sgr="${sgrWords.join(' ')}"` : ''}>${inner}</span>`
        : inner;
      at += textOf.length;
    }
    return out;
  };

  const render = (index) => {
    const entry = shown[index];
    if (!entry) return '<div class="ds-logview__line" role="option" aria-selected="false"></div>';
    const level = entry.level && !entry.cont
      ? `<span class="ds-logview__level">${icon(LEVEL_ICON[entry.level], 16)}<span class="ds-logview__word">${esc(t(LEVEL_WORD[entry.level]))}</span></span>`
      : '<span class="ds-logview__level"></span>';
    return `<div class="ds-logview__line" role="option" aria-selected="${selected.has(entry.seq)}" data-ds-key="l${entry.seq}"${entry.level ? ` data-level="${entry.level}"` : ''}>`
      + `<span class="ds-logview__num" data-line="${entry.seq}" aria-hidden="true"></span> `
      + `<span class="ds-logview__time">${esc(timeText(entry))}</span> ${level} `
      + `<span class="ds-logview__text">${textHtml(entry, index)}</span>${entry.text ? '' : `<span class="ds-sr">${esc(t('logBlank'))}</span>`}</div>`;
  };

  const list = windowRows(scroller, { content: listbox, count: 0, render, estimate: 24 });
  let follower = state.follow ? followEnd(scroller, { pill }) : null;

  /* What shows around the rows. */
  const widths = () => {
    listbox.style.setProperty('--ds-logview-chars', String(longest));
    listbox.style.setProperty('--ds-logview-digits', String(String(seq).length));
    listbox.style.setProperty('--ds-logview-time-chars', String(longestTime || 8));
    listbox.style.setProperty('--ds-logview-level-chars', String(Math.max(...LEVELS.map((level) => t(LEVEL_WORD[level]).length))));
  };

  const shownLevels = () => LEVELS.filter((level) => counts.get(level));

  const syncBar = () => {
    if (!state.tools) return;
    const present = shownLevels();
    const have = [...levelsBox.querySelectorAll('.ds-logview__chip')].map((chip) => chip.getAttribute('data-level'));
    if (present.join() !== have.join()) {
      for (const chip of levelsBox.querySelectorAll('.ds-logview__chip')) if (!present.includes(chip.getAttribute('data-level'))) chip.remove();
      present.forEach((level, index) => {
        let chip = levelsBox.querySelector(`.ds-logview__chip[data-level="${level}"]`);
        if (!chip) {
          const holder = doc.createElement('div');
          morphHtml(holder, levelChip(level));
          chip = holder.firstElementChild;
        }
        const before = levelsBox.querySelectorAll('.ds-logview__chip')[index] ?? null;
        if (chip !== before) levelsBox.insertBefore(chip, before);
      });
      levelsBox.hidden = present.length < 2;
    }
    for (const chip of levelsBox.querySelectorAll('.ds-logview__chip')) {
      const level = chip.getAttribute('data-level');
      const input = chip.querySelector('input');
      if (input.checked === state.hidden.has(level)) input.checked = !state.hidden.has(level);
      const tally = chip.querySelector('.ds-logview__tally');
      const text = number(counts.get(level) ?? 0);
      if (tally.textContent !== text) tally.textContent = text;
    }
    const total = entries.length;
    const lines = shown.length === total
      ? t(total === 1 ? 'logLinesOne' : 'logLines', { count: number(total) })
      : t('logShown', { shown: number(shown.length), count: number(total) });
    if (countText.textContent !== lines) countText.textContent = lines;
    const ordinal = current ? hits[current.hit][2] + current.k + 1 : 0;
    const findText = !state.query ? '' : hitTotal ? (ordinal ? t('logMatch', { index: number(ordinal), count: number(hitTotal) }) : t(hitTotal === 1 ? 'logMatchesOne' : 'logMatches', { count: number(hitTotal) })) : t('noResults');
    if (found.textContent !== findText) found.textContent = findText;
    button('previous').disabled = !hitTotal;
    button('next').disabled = !hitTotal;
    const selectedShown = selectedLines().length;
    const copyLabel = selectedShown > 1 ? t('logCopyLines', { count: number(selectedShown) }) : t('logCopyLine');
    const copyButton = button('copy');
    if (copyButton.getAttribute('aria-label') !== copyLabel) {
      copyButton.setAttribute('aria-label', copyLabel);
      copyButton.setAttribute('data-tip', copyLabel);
    }
    copyButton.disabled = !shown.length;
  };

  const syncEmpty = () => {
    const text = shown.length ? '' : entries.length ? t('logNoneShown') : t('logEmpty');
    empty.hidden = !text;
    if (empty.textContent !== text) empty.textContent = text;
  };

  /** Everything again: after the filters, the search or the view changed. */
  const redraw = ({ forget = false } = {}) => {
    if (destroyed) return;
    widths();
    list.set({ count: shown.length, forget });
    list.refresh();
    syncBar();
    syncEmpty();
  };

  const tell = (type, detail) => {
    if (signal.aborted) return;
    emit(el, type, detail);
    listeners[type]?.forEach((fn) => fn(detail));
  };

  const changed = () => tell('change', { query: state.query, levels: LEVELS.filter((level) => !state.hidden.has(level)), wrap: state.wrap, time: state.time, shown: shown.length, count: entries.length });

  /* Appending, batched to a frame. */
  let pending = [];
  let frame = 0;
  const view = doc.defaultView;
  const flush = () => {
    frame = 0;
    if (destroyed || !pending.length) return;
    const batch = pending;
    pending = [];
    const firstShown = shown.length;
    for (const input of batch) {
      const entry = entryOf(input);
      entries.push(entry);
      if (passes(entry)) {
        shown.push(entry);
        if (state.query) addHit(shown.length - 1);
      }
    }
    let trimmed = 0;
    if (state.limit && entries.length > state.limit) {
      // Trimmed in chunks of a tenth, so a log at its limit does not shift every line on every append.
      const drop = entries.length - state.limit + Math.floor(state.limit / 10);
      const gone = entries.splice(0, Math.min(drop, entries.length - 1));
      for (const entry of gone) {
        if (entry.level) counts.set(entry.level, counts.get(entry.level) - 1);
        selected.delete(entry.seq);
      }
      const cut = gone.at(-1).seq;
      while (trimmed < shown.length && shown[trimmed].seq <= cut) trimmed += 1;
      if (trimmed) {
        shown.splice(0, trimmed);
        const stamp = current ? hits[current.hit] : null;
        hits = hits.filter((hit) => hit[0] >= trimmed).map((hit) => [hit[0] - trimmed, hit[1], 0]);
        hitTotal = 0;
        for (const hit of hits) {
          hit[2] = hitTotal;
          hitTotal += hit[1];
        }
        current = stamp && stamp[0] >= trimmed ? { hit: hits.findIndex((hit) => hit[0] === stamp[0] - trimmed), k: current.k } : null;
      }
    }
    widths();
    const top = scroller.scrollTop;
    const active = list.get().active;
    list.set({ count: shown.length, active: trimmed ? Math.max(0, active - trimmed) : active });
    if (trimmed) {
      list.refresh();
      // What is on screen stays put: the lines above it went.
      if (!follower || scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) scroller.scrollTop = Math.max(0, top - trimmed * (list.row(list.get().start)?.getBoundingClientRect().height || 0));
    } else if (firstShown === 0) list.refresh();
    syncBar();
    syncEmpty();
  };
  const append = (value) => {
    const lines = linesOf(value);
    if (!lines.length || destroyed) return;
    pending.push(...lines);
    if (!frame) frame = view?.requestAnimationFrame ? view.requestAnimationFrame(flush) : (flush(), 0);
  };

  /** Drops every line. */
  const clearAll = () => {
    pending = [];
    entries = [];
    shown = [];
    hits = [];
    hitTotal = 0;
    current = null;
    counts.clear();
    selected.clear();
    anchor = null;
    longest = 0;
    longestTime = 0;
    redraw({ forget: true });
  };

  /** Everything at once (the source, set({ text })). */
  const replace = (value) => {
    clearAll();
    seq = 0;
    for (const input of linesOf(value)) entries.push(entryOf(input));
    refilter();
    redraw({ forget: true });
    follower?.stick();
  };

  /* Selection. */
  const selectedLines = () => shown.filter((entry) => selected.has(entry.seq));

  const selectionChanged = () => {
    list.refresh();
    syncBar();
    tell('select', { lines: [...selected].sort((a, b) => a - b) });
  };

  const selectRange = (from, to, add) => {
    if (!add) selected.clear();
    const [low, high] = from <= to ? [from, to] : [to, from];
    for (let index = Math.max(0, low); index <= Math.min(shown.length - 1, high); index += 1) selected.add(shown[index].seq);
  };

  const anchorIndex = () => {
    if (anchor === null) return -1;
    return shown.findIndex((entry) => entry.seq === anchor);
  };

  /* Search. */
  const scrollMarkIntoView = () => {
    const mark = listbox.querySelector('.ds-logview__match--current');
    if (!mark || state.wrap) return;
    const box = scroller.getBoundingClientRect();
    const rect = mark.getBoundingClientRect();
    const lead = (listbox.querySelector('.ds-logview__text')?.getBoundingClientRect().left ?? box.left) - box.left;
    if (rect.right > box.right) scroller.scrollLeft += rect.right - box.right + rect.width;
    else if (rect.left < box.left + lead) scroller.scrollLeft -= box.left + lead - rect.left + rect.width;
  };

  const goTo = (hit, k, speak = true) => {
    if (!hits.length) return;
    current = { hit, k };
    const index = hits[hit][0];
    list.refresh();
    list.set({ active: index });
    list.scrollTo(index, { align: 'center' });
    scrollMarkIntoView();
    syncBar();
    if (speak) announce(found.textContent);
  };

  const step = (direction) => {
    if (!hits.length) return;
    if (!current) {
      // From where the reader is: the first match at or after the top of the window (before it, going back).
      const top = list.get().start;
      let hit = hits.findIndex((each) => each[0] >= top);
      if (direction < 0) hit = hit <= 0 ? hits.length - 1 : hit - 1;
      else if (hit < 0) hit = 0;
      goTo(hit, direction < 0 ? hits[hit][1] - 1 : 0);
      return;
    }
    let { hit, k } = current;
    k += direction;
    if (k >= hits[hit][1]) [hit, k] = [(hit + 1) % hits.length, 0];
    else if (k < 0) {
      hit = (hit - 1 + hits.length) % hits.length;
      k = hits[hit][1] - 1;
    }
    goTo(hit, k);
  };

  const setQuery = (value) => {
    const query = String(value ?? '').toLowerCase();
    if (query === state.query) return false;
    state.query = query;
    refilter();
    redraw();
    return true;
  };

  /* Copy. */
  const copyLines = () => {
    let lines = selectedLines();
    if (!lines.length) {
      const active = shown[list.get().active];
      lines = active ? [active] : [];
    }
    if (!lines.length) return Promise.resolve('');
    const text = lines.map((entry) => entry.raw).join('\n');
    const clipboard = view?.navigator?.clipboard;
    if (!clipboard?.writeText) {
      announce(t('actionFailed'));
      return Promise.resolve('');
    }
    return clipboard.writeText(text).then(() => {
      announce(t(lines.length === 1 ? 'logCopiedOne' : 'logCopied', { count: number(lines.length) }));
      tell('copy', { text, count: lines.length });
      return text;
    }, (error) => {
      announce(t('actionFailed'));
      globalThis.reportError?.(error);
      return '';
    });
  };

  /* View options. */
  const setWrap = (on) => {
    if (state.wrap === on) return false;
    state.wrap = on;
    if (on) el.setAttribute('data-wrap', '');
    else el.removeAttribute('data-wrap');
    button('wrap').setAttribute('aria-pressed', String(on));
    prefs?.set('wrap', on);
    redraw({ forget: true });
    return true;
  };

  const setTime = (mode) => {
    const next = ['off', 'full', 'time'].includes(mode) ? mode : 'time';
    if (state.time === next) return false;
    state.time = next;
    el.setAttribute('data-time', next);
    button('time').setAttribute('aria-pressed', String(next !== 'off'));
    prefs?.set('time', next);
    longestTime = entries.reduce((max, entry) => Math.max(max, timeText(entry).length), 0);
    redraw({ forget: true });
    return true;
  };

  const setFollow = (on) => {
    if (state.follow === on) return;
    state.follow = on;
    pill.parentElement.hidden = !on;
    if (on) follower = followEnd(scroller, { pill });
    else {
      follower?.destroy();
      follower = null;
      pill.hidden = true;
    }
  };

  const setTools = (on) => {
    if (state.tools === on) return;
    state.tools = on;
    bar.hidden = !on;
    syncBar();
  };

  const setLevels = (levels) => {
    const visible = new Set(levels);
    const hidden = new Set(LEVELS.filter((level) => !visible.has(level)));
    if ([...hidden].join() === [...state.hidden].join()) return false;
    state.hidden = hidden;
    refilter();
    redraw();
    return true;
  };

  /* Input. */
  bar.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target)?.closest?.('[data-ds-logview-act]');
    if (!target || target.disabled) return;
    const act = target.getAttribute('data-ds-logview-act');
    if (act === 'previous' || act === 'next') step(act === 'next' ? 1 : -1);
    else if (act === 'only') {
      state.only = !state.only;
      target.setAttribute('aria-pressed', String(state.only));
      refilter();
      redraw();
      announce(countText.textContent);
      changed();
    } else if (act === 'wrap') {
      setWrap(!state.wrap);
      changed();
    } else if (act === 'time') {
      setTime(state.time === 'off' ? 'time' : 'off');
      changed();
    } else if (act === 'copy') copyLines();
  }, { signal });

  bar.addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const level = input?.getAttribute?.('data-ds-logview-level');
    if (!level) return;
    if (input.checked) state.hidden.delete(level);
    else state.hidden.add(level);
    refilter();
    redraw();
    announce(countText.textContent);
    changed();
  }, { signal });

  field.addEventListener('input', () => {
    if (setQuery(field.value)) changed();
  }, { signal });

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape' && field.value) {
      // Clears the search first; the next Escape is the page's.
      event.preventDefault();
      field.value = '';
      if (setQuery('')) changed();
    } else if (event.key === 'ArrowDown' && !event.altKey && !event.shiftKey && shown.length) {
      event.preventDefault();
      list.focus(current ? hits[current.hit][0] : list.get().active);
    }
  }, { signal });

  // Shift+click picks a range of lines: no text selection grows with it (the focus follows in the click).
  listbox.addEventListener('mousedown', (event) => {
    if (event.shiftKey && list.indexOf(/** @type {Node} */ (event.target)) >= 0) event.preventDefault();
  }, { signal });

  // Whether the Latest pill held the focus when it was pressed: it hides at once, so the focus goes to the last line.
  let latestFocused = false;
  scroller.addEventListener('click', (event) => {
    if (/** @type {Element} */ (event.target)?.closest?.('[data-ds-logview-act="latest"]')) latestFocused = pill.contains(doc.activeElement);
  }, { capture: true, signal });

  scroller.addEventListener('click', (event) => {
    if (/** @type {Element} */ (event.target)?.closest?.('[data-ds-logview-act="latest"]')) {
      if (latestFocused && shown.length) list.focus(shown.length - 1);
      latestFocused = false;
      announce(t('logFollowing'));
      return;
    }
    const index = list.indexOf(/** @type {Node} */ (event.target));
    if (index < 0) return;
    // Dragging over the text selects it for the page's own copy: the lines stay as they were.
    const text = view?.getSelection?.();
    if (text && !text.isCollapsed && listbox.contains(text.anchorNode)) return;
    const entry = shown[index];
    if (event.shiftKey) {
      const from = anchorIndex();
      selectRange(from < 0 ? index : from, index, event.ctrlKey || event.metaKey);
      list.focus(index);
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(entry.seq)) selected.delete(entry.seq);
      else selected.add(entry.seq);
      anchor = entry.seq;
    } else {
      const only = selected.size === 1 && selected.has(entry.seq);
      selected.clear();
      if (!only) selected.add(entry.seq);
      anchor = entry.seq;
    }
    selectionChanged();
  }, { signal });

  listbox.addEventListener('keydown', (event) => {
    const index = list.indexOf(/** @type {Node} */ (event.target));
    if (index < 0) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (mod && !event.altKey && (key === 'f' || key === 'F') && state.tools) {
      event.preventDefault();
      field.focus();
      field.select();
      return;
    }
    if (mod && !event.altKey && (key === 'a' || key === 'A')) {
      event.preventDefault();
      selectRange(0, shown.length - 1, false);
      selectionChanged();
      announce(t('logSelected', { count: number(selected.size) }));
      return;
    }
    if (mod && !event.altKey && (key === 'c' || key === 'C')) {
      const text = view?.getSelection?.();
      if (text && !text.isCollapsed) return;
      event.preventDefault();
      copyLines();
      return;
    }
    if (key === ' ' && !mod && !event.altKey) {
      event.preventDefault();
      const entry = shown[index];
      if (event.shiftKey) {
        const from = anchorIndex();
        selectRange(from < 0 ? index : from, index, false);
      } else {
        if (selected.has(entry.seq)) selected.delete(entry.seq);
        else selected.add(entry.seq);
        anchor = entry.seq;
      }
      selectionChanged();
      return;
    }
    if (event.shiftKey && !mod && !event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
      event.preventDefault();
      const to = Math.min(shown.length - 1, Math.max(0, index + (key === 'ArrowDown' ? 1 : -1)));
      if (anchor === null || anchorIndex() < 0) anchor = shown[index].seq;
      selectRange(anchorIndex(), to, false);
      list.focus(to);
      selectionChanged();
      return;
    }
    if (event.shiftKey && mod && !event.altKey && (key === 'Home' || key === 'End')) {
      event.preventDefault();
      const to = key === 'Home' ? 0 : shown.length - 1;
      if (anchor === null || anchorIndex() < 0) anchor = shown[index].seq;
      selectRange(anchorIndex(), to, false);
      list.focus(to);
      selectionChanged();
      return;
    }
    if (key === 'Escape' && selected.size) {
      event.preventDefault();
      selected.clear();
      anchor = null;
      selectionChanged();
    }
  }, { signal });

  // A page that re-renders the source: added lines append, other text starts again.
  const Watch = view?.MutationObserver;
  const watcher = source && Watch ? new Watch(() => {
    const text = source.textContent ?? '';
    if (text === sourceText) return;
    if (text.startsWith(sourceText) && (sourceText === '' || sourceText.endsWith('\n'))) append(text.slice(sourceText.length));
    else replace(text);
    sourceText = text;
  }) : null;
  if (source) {
    watcher?.observe(source, { childList: true, characterData: true, subtree: true });
    source.hidden = true;
    own(source, 'attrs', 'hidden');
  }

  const handle = {
    get() {
      return {
        count: entries.length,
        shown: shown.length,
        query: state.query,
        levels: LEVELS.filter((level) => !state.hidden.has(level)),
        only: state.only,
        wrap: state.wrap,
        time: state.time,
        selected: [...selected].sort((a, b) => a - b),
        lines: entries.map((entry) => entry.raw),
      };
    },
    set(value) {
      const next = typeof value === 'string' || Array.isArray(value) ? { text: value } : value ?? {};
      let change = false;
      if (next.text !== undefined) replace(next.text);
      if (next.query !== undefined) {
        field.value = String(next.query);
        change = setQuery(next.query) || change;
      }
      if (next.only !== undefined && Boolean(next.only) !== state.only) {
        state.only = Boolean(next.only);
        button('only').setAttribute('aria-pressed', String(state.only));
        refilter();
        redraw();
        change = true;
      }
      if (next.levels !== undefined) change = setLevels(next.levels) || change;
      if (next.wrap !== undefined) change = setWrap(Boolean(next.wrap)) || change;
      if (next.time !== undefined) change = setTime(next.time === false ? 'off' : next.time === true ? 'time' : next.time) || change;
      if (next.limit !== undefined) state.limit = Math.max(0, Number(next.limit) || 0);
      if (next.selected !== undefined) {
        selected.clear();
        for (const line of next.selected) selected.add(Number(line));
        selectionChanged();
      }
      if (change) changed();
    },
    append,
    clear() {
      clearAll();
    },
    copy: copyLines,
    find(direction = 'next') {
      step(direction === 'previous' ? -1 : 1);
    },
    latest() {
      follower?.stick();
    },
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    /** Applies the options whose attributes changed (`names`, from DS.core), else all of them. */
    update(names) {
      const has = (attribute) => !Array.isArray(names) || names.includes(attribute);
      const options = readOptions(el);
      let change = false;
      if (has('data-ds-logview-wrap')) change = setWrap(options.wrap) || change;
      if (has('data-ds-logview-time')) change = setTime(options.time) || change;
      if (has('data-ds-logview-limit')) state.limit = options.limit ?? LIMIT;
      if (has('data-ds-logview-follow')) setFollow(options.follow);
      if (has('data-ds-logview-tools')) setTools(options.tools);
      if (has('aria-label')) listbox.setAttribute('aria-label', name());
      if (change) changed();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) view?.cancelAnimationFrame?.(frame);
      watcher?.disconnect();
      follower?.destroy();
      list.destroy();
      prefs?.destroy();
      life.abort();
      Object.values(listeners).forEach((set) => set.clear());
      bar.remove();
      scroller.remove();
      if (source) {
        disown(source, 'attrs', 'hidden');
        source.hidden = false;
      }
      disown(el, 'attrs', 'data-time');
      disown(el, 'attrs', 'data-wrap');
      el.removeAttribute('data-time');
      el.removeAttribute('data-wrap');
    },
  };

  if (start.lines !== undefined) replace(start.lines);
  else if (source) replace(sourceText);
  else redraw();
  return handle;
}

define('logview', {
  attribute: 'data-ds-logview',
  attributes: ['data-ds-logview-wrap', 'data-ds-logview-time', 'data-ds-logview-limit', 'data-ds-logview-follow', 'data-ds-logview-tools', 'aria-label'],
  init(el, ctx) {
    return controller(el, { ...readOptions(el), fromSource: true }, ctx.signal);
  },
});

/**
 * A log viewer driven from the page; the same controller the attribute path
 * makes. `lines` (text or a list of lines or `{ text, level, time }`;
 * default the .ds-logview__source inside), `follow`, `wrap`, `time`
 * ('time', 'full', 'off'), `limit`, `tools` and `store`.
 * @param {Element} el
 * @param {object} [options]
 */
export function create(el, options = {}) {
  return controller(el, { ...readOptions(el), ...options, fromSource: options.lines === undefined }, null);
}
