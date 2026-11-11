/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Command palette (DS.command): one search field over every command of an
 * app, in a dialog. The WAI-ARIA combobox pattern inside a modal dialog:
 * the field keeps focus and names the active option through
 * aria-activedescendant, the list is a listbox of grouped options.
 *
 *   <button class="ds-btn" type="button" data-ds-open="#palette">Search</button>
 *   <dialog class="ds-dialog ds-command" id="palette" data-ds-command aria-label="Command palette">
 *     <div class="ds-dialog__backdrop" data-ds-close></div>
 *     <div class="ds-dialog__box">
 *       <div class="ds-command__search">(search 20)
 *         <input class="ds-command__input" type="text" role="combobox" aria-label="Search commands" placeholder="Search or run a command"></div>
 *       <div class="ds-command__list" role="listbox"> ...options in groups, or none: commands from create() </div>
 *   </dialog>
 *
 *   const palette = DS.command.create(dialog, { commands, providers });
 *   palette.open();  palette.set({ commands });  palette.on('select', ({ command }) => ...);
 *   DS.command.fuzzy('adddev', 'Add a device');   // { score, ranges: [[0, 3], [6, 9]] }
 *
 * Opening: Ctrl+K (Command+K on Apple systems) through DS.hotkeys, or the
 * combo of data-ds-command-hotkey ("off": none); the same combo closes it
 * again. Any [data-ds-open] button opens it too (DS.overlay).
 *
 * Commands (data, or options in the markup, read once): `id`, `label`,
 * `group`, `keywords`, `description`, `icon` (a glyph of DS.icons),
 * `shortcut` (a combo or a list; shown as keys, and registered with
 * DS.hotkeys so it works without the palette and shows on the shortcut
 * sheet), `href` (followed), `run(command, palette)`, `disabled`,
 * `keepOpen`, and `children`: a list, or a function (query, { signal })
 * that returns one (or a promise of one), which makes the command a page
 * of its own. `prefix` (one character, such as ">") enters that page when
 * typed first. A page shows its label before the field; Backspace in an
 * empty field and Escape go back one page.
 *
 * Search: every word typed must match the label (letters in order, gaps
 * allowed) or a keyword; word starts and runs of letters score higher,
 * groups follow their best match, and the matched letters are marked
 * (<mark class="ds-command__match">). Providers (`providers`, each
 * { group, search(query, { signal }), minLength }) add results as they
 * arrive; a newer query aborts the older one (its signal), the list says
 * it is busy (aria-busy, a spinner after --ds-delay-loader) and a failure
 * says so in the status line. Typing waits --ds-dur-fast before asking.
 *
 * Recent: the last commands run (`recent`, default 5; 0: none) are
 * remembered through DS.store (namespace "command", key: the dialog's id)
 * and lead the list while the field is empty.
 *
 * Keys: ArrowDown and ArrowUp move the active option (wrapping), PageDown
 * and PageUp to the next or previous group, Enter runs it; Home and End
 * stay the field's. A pointer that moves over an option makes it active;
 * a click runs it. Escape goes back one page, else closes (DS.overlay).
 * Running a command closes the palette first (focus goes back to its
 * opener), then runs it; a page opens in place.
 *
 * Events on the dialog: ds:select ({ command, query }), ds:query ({ query,
 * page }), and DS.overlay's ds:open and ds:close.
 *
 * Strings: commandOpen, commandRecent, commandResults, commandResultOne,
 * commandEmpty, commandFailed, commandBack and loading.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, safeHref, t } from './core.js';
import { motionDuration } from './motion.js';
import { chevronLeft, chevronRight, iconElement } from './icons.js';
import { open as openOverlay, close as closeOverlay, topmost } from './overlay.js';
import { format as formatCombo, register } from './hotkeys.js';
import { open as openStore } from './store.js';

/** How many recent commands lead an empty field, by default. */
const RECENT = 5;

/** The opening combo, by default. */
const HOTKEY = 'mod+k';

/* ── Search ─────────────────────────────────────────── */

/** One character folded for matching: lower case, without its accents. */
function fold(char) {
  const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return base.length === 1 ? base : char.toLowerCase().charAt(0) || char;
}

/** Whether the character at `index` starts a word (after a space, a sign, or a lower case letter before a capital). */
function wordStart(text, index) {
  if (index === 0) return true;
  const before = text.charAt(index - 1);
  const here = text.charAt(index);
  if (!/[\p{L}\p{N}]/u.test(before)) return true;
  return /\p{Ll}/u.test(before) && /\p{Lu}/u.test(here);
}

/** The ranges [start, end) of a sorted list of indices. */
function rangesOf(indices) {
  const ranges = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] += 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

/** The score of the letters at `indices` in `text` (word starts and runs count). */
function scoreOf(text, indices) {
  let score = 0;
  indices.forEach((index, at) => {
    score += 1;
    if (wordStart(text, index)) score += 8;
    if (at > 0 && indices[at - 1] === index - 1) score += 5;
    else if (at > 0) score -= Math.min(4, (index - indices[at - 1]) * 0.2);
  });
  if (indices[0] === 0) score += 6;
  return score;
}

/** One word of the query in `text`: the best of a run of letters and two subsequences (plain, and one that prefers word starts). */
function matchWord(word, text, folded) {
  const candidates = [];
  let from = folded.indexOf(word);
  while (from >= 0) {
    candidates.push(Array.from(word, (_, at) => from + at));
    if (wordStart(text, from)) break;
    from = folded.indexOf(word, from + 1);
  }
  for (const starts of [false, true]) {
    const indices = [];
    let at = -1;
    for (const char of word) {
      let next = -1;
      if (starts) {
        for (let index = at + 1; index < folded.length; index += 1) {
          if (folded[index] === char && wordStart(text, index)) {
            next = index;
            break;
          }
        }
      }
      if (next < 0) next = folded.indexOf(char, at + 1);
      if (next < 0) break;
      indices.push(next);
      at = next;
    }
    if (indices.length === word.length) candidates.push(indices);
  }
  let best = null;
  for (const indices of candidates) {
    const score = scoreOf(text, indices) + (indices.length > 1 && indices[indices.length - 1] - indices[0] === indices.length - 1 ? 10 : 0);
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

/**
 * How well `query` matches `text`: every word of the query must match as
 * letters in order (gaps allowed), case and accents aside. Returns the
 * score (higher is better; word starts, runs of letters and an early
 * match count) and the matched ranges of `text` ([start, end) pairs, for
 * the marks), or null. An empty query matches with score 0.
 * @param {string} query
 * @param {string} text
 * @returns {{ score: number, ranges: [number, number][] }|null}
 */
export function fuzzy(query, text) {
  const source = String(text ?? '');
  const words = String(query ?? '').trim().split(/\s+/).filter(Boolean).map((word) => Array.from(word, fold).join(''));
  if (!words.length) return { score: 0, ranges: [] };
  // One folded character per character of the text (an astral one is two code units).
  const folded = Array.from(source.split(''), fold);
  let score = 0;
  const used = new Set();
  for (const word of words) {
    const found = matchWord(word, source, folded);
    if (!found) return null;
    score += found.score;
    for (const index of found.indices) used.add(index);
  }
  // A shorter text with the same letters matched is the closer one.
  score -= source.length * 0.01;
  return { score, ranges: rangesOf([...used].sort((a, b) => a - b)) };
}

/**
 * The commands that match `query`, best first: the label through fuzzy()
 * (with its ranges), else a keyword (at a lower score, no ranges). Equal
 * scores keep the given order; an empty query keeps them all.
 * @template {{ label: string, keywords?: string[] }} C
 * @param {C[]} commands
 * @param {string} query
 * @returns {{ command: C, score: number, ranges: [number, number][] }[]}
 */
export function rank(commands, query) {
  const out = [];
  commands.forEach((command, order) => {
    const label = fuzzy(query, command.label);
    let best = label ? { score: label.score, ranges: label.ranges } : null;
    for (const keyword of command.keywords ?? []) {
      const found = fuzzy(query, keyword);
      if (found && (!best || found.score * 0.7 > best.score)) best = { score: found.score * 0.7, ranges: label?.ranges ?? [] };
    }
    if (best) out.push({ command, score: best.score, ranges: best.ranges, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ command, score, ranges }) => ({ command, score, ranges }));
}

/* ── Data ───────────────────────────────────────────── */

/** A command as the palette keeps it. */
function normalize(given, index) {
  const label = String(given?.label ?? '').replace(/\s+/g, ' ').trim();
  const shortcut = given?.shortcut ? (Array.isArray(given.shortcut) ? given.shortcut : [given.shortcut]).map(String).filter(Boolean) : [];
  return {
    ...given,
    id: String(given?.id ?? (label || `command-${index}`)),
    label,
    group: given?.group ? String(given.group) : '',
    keywords: Array.isArray(given?.keywords) ? given.keywords.map(String) : typeof given?.keywords === 'string' ? given.keywords.split(/[,\s]+/).filter(Boolean) : [],
    description: given?.description ? String(given.description) : '',
    shortcut,
    disabled: Boolean(given?.disabled),
  };
}

/**
 * The commands written in the markup: each option of the list (role
 * option, or .ds-command__item) with its group's heading, its
 * data-ds-command-* attributes (id, keywords, shortcut, href, prefix) and
 * its label (.ds-command__label, else its text) and description.
 */
function fromMarkup(list) {
  if (!list) return [];
  const nodes = [...list.querySelectorAll('[role="option"], .ds-command__item')];
  return nodes.map((option, index) => {
    const group = option.closest('[role="group"], .ds-command__group');
    const heading = group?.querySelector('.ds-command__heading')?.textContent?.trim() ?? '';
    const label = (option.querySelector('.ds-command__label') ?? option).textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const icon = option.querySelector('svg');
    return {
      id: option.getAttribute('data-ds-command-id') || option.id || `${label}-${index}`,
      label,
      group: heading,
      keywords: option.getAttribute('data-ds-command-keywords') ?? '',
      description: option.querySelector('.ds-command__description')?.textContent?.trim() ?? '',
      shortcut: (option.getAttribute('data-ds-command-shortcut') ?? '').split(/\s+/).filter(Boolean),
      href: option.getAttribute('data-ds-command-href') || undefined,
      disabled: option.getAttribute('aria-disabled') === 'true',
      markupIcon: icon ? icon.cloneNode(true) : null,
    };
  });
}

/** Every command of a list and its static pages, for the recent list and the shortcuts. */
function flatten(commands, out = []) {
  for (const command of commands) {
    out.push(command);
    if (Array.isArray(command.children)) flatten(command.children.map(normalize), out);
  }
  return out;
}

/* ── The palette ────────────────────────────────────── */

let palettes = 0;

function controller(el, given = {}, signal = null) {
  const doc = el.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  palettes += 1;
  const uid = `ds-command-${palettes}`;
  const box = el.querySelector('.ds-dialog__box') ?? el;
  const input = /** @type {HTMLInputElement|null} */ (el.querySelector('.ds-command__input'));
  if (!input) return null;
  const search = input.closest('.ds-command__search') ?? input.parentElement;
  let list = el.querySelector('.ds-command__list');
  const written = fromMarkup(list);
  // The page's options, given back on destroy: a new init reads the same commands (their shortcuts too).
  const listBefore = list ? Array.from(list.childNodes, (node) => node.cloneNode(true)) : null;
  if (!list) {
    list = doc.createElement('div');
    list.className = 'ds-command__list';
    search.after(list);
  }
  list.setAttribute('role', 'listbox');
  if (!list.id) list.id = `${uid}-list`;
  let empty = el.querySelector('.ds-command__empty');
  if (!empty) {
    empty = doc.createElement('p');
    empty.className = 'ds-command__empty';
    list.after(empty);
  }
  empty.hidden = true;
  let status = el.querySelector('.ds-command__status');
  if (!status) {
    status = doc.createElement('p');
    status.className = 'ds-command__status';
    const foot = el.querySelector('.ds-command__foot');
    if (foot) foot.append(status);
    else empty.after(status);
  }
  status.setAttribute('role', 'status');
  const statusText = doc.createElement('span');
  status.replaceChildren(statusText);

  // The field as the APG combobox with a list that shows whenever it has options (paint() keeps aria-expanded).
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  if (!list.hasAttribute('aria-label') && !list.hasAttribute('aria-labelledby')) {
    const name = input.getAttribute('aria-label') || el.getAttribute('aria-label');
    if (name) list.setAttribute('aria-label', name);
  }
  const listName = list.getAttribute('aria-label');
  const placeholder = input.getAttribute('placeholder') ?? '';

  // A page's label and the way back, before the field.
  const back = doc.createElement('button');
  back.type = 'button';
  back.className = 'ds-command__back';
  back.hidden = true;
  back.tabIndex = -1;
  back.append(iconElement(chevronLeft, 16, undefined, doc));
  const backLabel = doc.createElement('span');
  back.append(backLabel);
  input.before(back);

  const recentCount = Number.isInteger(given.recent) ? Math.max(0, given.recent) : RECENT;
  const store = recentCount > 0 ? openStore('command') : null;
  const storeKey = el.id || 'palette';

  let commands = (given.commands ?? written).map(normalize);
  let providers = Array.isArray(given.providers) ? given.providers : [];
  const listeners = new Map();
  /** The pages entered, the deepest last: { command, label }. */
  let pages = [];
  let query = '';
  let rows = [];
  let active = -1;
  let runId = 0;
  let pending = null;
  let timer = 0;
  let spinnerTimer = 0;
  let shortcuts = [];
  /** Set by openPalette(): the open that follows keeps what it prepared. */
  let prepared = false;
  // Every listener goes with destroy(), and with the behaviour's signal.
  const lifetime = new AbortController();
  signal?.addEventListener('abort', () => lifetime.abort(), { once: true });

  const fire = (type, detail) => {
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  const page = () => pages[pages.length - 1] ?? null;

  /** The recent commands that still exist, newest first. */
  const recent = () => {
    if (!store) return [];
    const known = new Map(flatten(commands).map((command) => [command.id, command]));
    const ids = store.get(storeKey, []);
    return (Array.isArray(ids) ? ids : []).map((id) => known.get(id)).filter((command) => command && !command.disabled).slice(0, recentCount);
  };

  /**
   * Remembers a command of `commands` (or of their list pages): only those
   * can show under Recent again, so a provider's result or an item of a
   * page function never takes a slot.
   */
  const remember = (command) => {
    if (!store || typeof command.children === 'function') return;
    if (!flatten(commands).some((each) => each.id === command.id)) return;
    const ids = store.get(storeKey, []);
    const next = [command.id, ...(Array.isArray(ids) ? ids : []).filter((id) => id !== command.id)].slice(0, recentCount);
    store.set(storeKey, next);
  };

  /* Shortcuts: each command's combo runs it, without the palette. */
  const registerShortcuts = () => {
    for (const handle of shortcuts) handle.destroy();
    shortcuts = [];
    if (given.shortcuts === false) return;
    for (const command of flatten(commands)) {
      if (!command.shortcut.length || command.children) continue;
      try {
        shortcuts.push(register(command.shortcut, () => {
          if (command.disabled) return false;
          run(command, false);
          return undefined;
        }, { description: command.label, group: command.group || null, root: doc }));
      } catch (error) {
        view.reportError?.(error);
      }
    }
  };

  /* ── Rendering ── */

  /** The label with its matched letters marked. */
  const labelNode = (text, ranges) => {
    const span = doc.createElement('span');
    span.className = 'ds-command__label';
    let at = 0;
    for (const [start, end] of ranges) {
      if (start > at) span.append(text.slice(at, start));
      const mark = doc.createElement('mark');
      mark.className = 'ds-command__match';
      mark.textContent = text.slice(start, end);
      span.append(mark);
      at = end;
    }
    if (at < text.length) span.append(text.slice(at));
    return span;
  };

  const optionNode = (command, ranges, index) => {
    const option = doc.createElement('div');
    option.className = 'ds-command__item';
    option.id = `${uid}-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.setAttribute('data-ds-key', command.id);
    if (command.disabled) option.setAttribute('aria-disabled', 'true');
    if (command.markupIcon) {
      const icon = command.markupIcon.cloneNode(true);
      icon.setAttribute('class', 'ds-command__icon');
      icon.setAttribute('aria-hidden', 'true');
      option.append(icon);
    } else if (command.icon) option.append(iconElement(command.icon, 20, 'ds-command__icon', doc));
    const content = doc.createElement('span');
    content.className = 'ds-command__content';
    content.append(labelNode(command.label, ranges));
    if (command.description) {
      const description = doc.createElement('span');
      description.className = 'ds-command__description';
      description.textContent = command.description;
      content.append(description);
    }
    option.append(content);
    if (command.shortcut.length) {
      const keys = doc.createElement('span');
      keys.className = 'ds-command__shortcut';
      keys.setAttribute('aria-hidden', 'true');
      const formatted = formatCombo(command.shortcut[0]);
      for (const key of formatted.keys) {
        const kbd = doc.createElement('kbd');
        kbd.className = 'ds-kbd';
        kbd.textContent = key;
        keys.append(kbd);
      }
      option.setAttribute('aria-keyshortcuts', command.shortcut.map((combo) => formatCombo(combo).aria).join(' '));
      option.append(keys);
    }
    if (command.children) option.append(iconElement(chevronRight, 20, 'ds-command__chevron', doc));
    return option;
  };

  /** Groups in order: [{ name, items: [{ command, ranges }] }]. */
  const grouped = (entries) => {
    const groups = new Map();
    for (const entry of entries) {
      const name = entry.group ?? entry.command.group ?? '';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(entry);
    }
    return [...groups].map(([name, items]) => ({ name, items }));
  };

  /** The local results of the current page and query, grouped and ranked. */
  const localGroups = () => {
    const current = page();
    const source = current ? (Array.isArray(current.command.children) ? current.command.children.map(normalize) : []) : commands;
    if (!query) {
      const groups = [];
      if (!current) {
        const last = recent();
        if (last.length) groups.push({ name: t('commandRecent'), items: last.map((command) => ({ command, ranges: [], recent: true })) });
      }
      return [...groups, ...grouped(source.map((command) => ({ command, ranges: [] })))];
    }
    const ranked = rank(source, query);
    // Groups follow their best match; inside a group the best first.
    return grouped(ranked);
  };

  let remote = [];
  let failed = false;
  let busy = false;

  const paint = () => {
    const groups = [...localGroups(), ...remote];
    const nodes = [];
    const flat = [];
    let headingCount = 0;
    for (const group of groups) {
      if (!group.items.length) continue;
      const options = group.items.map((entry) => {
        const node = optionNode(entry.command, entry.ranges ?? [], flat.length);
        flat.push({ command: entry.command, node });
        return node;
      });
      if (!group.name) {
        nodes.push(...options);
        continue;
      }
      headingCount += 1;
      const wrap = doc.createElement('div');
      wrap.className = 'ds-command__group';
      wrap.setAttribute('role', 'group');
      const heading = doc.createElement('div');
      heading.className = 'ds-command__heading';
      heading.id = `${uid}-group-${headingCount}`;
      heading.setAttribute('role', 'presentation');
      heading.textContent = group.name;
      wrap.setAttribute('aria-labelledby', heading.id);
      wrap.append(heading, ...options);
      nodes.push(wrap);
    }
    const before = rows[active]?.command.id;
    list.replaceChildren(...nodes);
    rows = flat;
    const keep = rows.findIndex((row) => row.command.id === before);
    setActive(keep >= 0 && query === lastQuery ? keep : rows.findIndex((row) => !row.command.disabled), false);
    lastQuery = query;
    empty.hidden = rows.length > 0 || busy || !query;
    list.hidden = rows.length === 0;
    // The APG combobox: expanded only while its list shows.
    input.setAttribute('aria-expanded', String(rows.length > 0));
    if (!empty.hidden) empty.textContent = t('commandEmpty', { query });
    writeStatus();
  };
  let lastQuery = '';

  const writeStatus = () => {
    let text = '';
    if (failed) text = t('commandFailed');
    else if (busy) text = t('loading');
    else if (query) text = rows.length === 1 ? t('commandResultOne') : t('commandResults', { count: rows.length });
    if (statusText.textContent !== text) statusText.textContent = text;
  };

  const setActive = (index, scroll = true) => {
    const previous = rows[active]?.node;
    if (previous) {
      previous.removeAttribute('data-active');
      previous.setAttribute('aria-selected', 'false');
    }
    active = index >= 0 && index < rows.length ? index : -1;
    const row = rows[active];
    if (!row) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    row.node.setAttribute('data-active', '');
    row.node.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.node.id);
    if (scroll) row.node.scrollIntoView?.({ block: 'nearest' });
  };

  /* ── Providers ── */

  const showSpinner = (on) => {
    view.clearTimeout(spinnerTimer);
    status.querySelector('.ds-spinner')?.remove();
    if (!on) return;
    spinnerTimer = view.setTimeout(() => {
      if (!busy) return;
      const spinner = doc.createElement('span');
      spinner.className = 'ds-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      status.prepend(spinner);
    }, motionDuration(el, '--ds-delay-loader'));
  };

  /** Asks the providers (or the page's function) for the current query; the newest call wins. */
  const ask = () => {
    pending?.abort();
    pending = null;
    const current = page();
    const sources = current
      ? (typeof current.command.children === 'function' ? [{ group: '', search: current.command.children, minLength: 0 }] : [])
      : providers;
    const asked = sources.filter((source) => typeof source?.search === 'function' && query.length >= (source.minLength ?? 1));
    remote = [];
    failed = false;
    if (!asked.length) {
      busy = false;
      list.removeAttribute('aria-busy');
      showSpinner(false);
      paint();
      return;
    }
    const controllerOfAsk = new AbortController();
    pending = controllerOfAsk;
    const id = ++runId;
    busy = true;
    list.setAttribute('aria-busy', 'true');
    showSpinner(true);
    paint();
    const results = asked.map(() => null);
    let left = asked.length;
    asked.forEach((source, at) => {
      let answer;
      try {
        answer = source.search(query, { signal: controllerOfAsk.signal, page: current?.command ?? null });
      } catch (error) {
        answer = Promise.reject(error);
      }
      Promise.resolve(answer).then((found) => {
        if (id !== runId) return;
        const items = (Array.isArray(found) ? found : []).map(normalize);
        const ranked = query ? rank(items, query) : [];
        const byId = new Map(ranked.map((entry) => [entry.command.id, entry.ranges]));
        // The provider's order stays (it searched); the marks come from here.
        results[at] = items.map((command) => ({ command, ranges: byId.get(command.id) ?? [], group: source.group ?? command.group ?? '' }));
      }, (error) => {
        if (id !== runId || controllerOfAsk.signal.aborted) return;
        failed = true;
        if (error?.name !== 'AbortError') view.reportError?.(error);
      }).finally(() => {
        if (id !== runId) return;
        left -= 1;
        remote = grouped(results.flat().filter(Boolean));
        if (!left) {
          busy = false;
          pending = null;
          list.removeAttribute('aria-busy');
          showSpinner(false);
        }
        paint();
      });
    });
  };

  const changed = () => {
    view.clearTimeout(timer);
    paint();
    fire('query', { query, page: page()?.command ?? null });
    const wait = motionDuration(el, '--ds-dur-fast');
    timer = view.setTimeout(ask, query ? wait : 0);
  };

  /* ── Pages ── */

  const showPage = () => {
    const current = page();
    back.hidden = !current;
    backLabel.textContent = current?.command.label ?? '';
    back.setAttribute('aria-label', current ? t('commandBack', { page: pages[pages.length - 2]?.command.label ?? listName ?? '' }).trim() : '');
    input.setAttribute('placeholder', current ? current.command.placeholder ?? placeholder : placeholder);
    if (current) list.setAttribute('aria-label', current.command.label);
    else if (listName) list.setAttribute('aria-label', listName);
  };

  const enter = (command) => {
    pages.push({ command });
    query = '';
    input.value = '';
    showPage();
    changed();
  };

  const leave = () => {
    if (!pages.length) return false;
    pages.pop();
    query = '';
    input.value = '';
    showPage();
    changed();
    return true;
  };

  /* ── Running ── */

  function run(command, fromPalette = true) {
    if (!command || command.disabled) return;
    if (command.children) {
      if (!el.matches('[data-state="open"], [open]')) openPalette();
      enter(command);
      return;
    }
    remember(command);
    const detail = { command, query };
    const stay = command.keepOpen === true && fromPalette;
    if (fromPalette && !stay) closeOverlay(el, { reason: 'select' });
    fire('select', detail);
    try {
      if (typeof command.run === 'function') command.run(command, api);
      else if (command.href) {
        // An href from data (a provider's result) only when safe: never a javascript: or data: URL.
        const href = safeHref(command.href);
        if (!href) throw new TypeError(`DS.command: "${command.label}" has an href that is not a safe link`);
        view.location.assign(href);
      }
    } catch (error) {
      view.reportError?.(error);
    }
    if (stay) paint();
  }

  /* ── Events ── */

  const options = { signal: lifetime.signal };
  input.addEventListener('input', () => {
    const value = input.value;
    // A prefix typed first enters its page.
    if (!pages.length && value.length >= 1) {
      const target = flatten(commands).find((command) => command.prefix && command.children && value.startsWith(command.prefix));
      if (target) {
        pages.push({ command: target });
        input.value = value.slice(target.prefix.length).replace(/^\s+/, '');
        query = input.value.trim();
        showPage();
        changed();
        return;
      }
    }
    query = value.trim();
    changed();
  }, options);

  input.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = (from, by) => (rows.length ? (from + by + rows.length) % rows.length : -1);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(step(active < 0 ? (event.key === 'ArrowDown' ? -1 : 0) : active, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      if (!rows.length) return;
      event.preventDefault();
      const groupOf = (index) => rows[index]?.node.closest('.ds-command__group');
      const here = groupOf(active);
      let index = active;
      if (event.key === 'PageDown') {
        while (index < rows.length - 1 && groupOf(index) === here) index += 1;
      } else {
        // The start of this group, else of the one before.
        while (index > 0 && groupOf(index - 1) === here) index -= 1;
        if (index === active && index > 0) {
          index -= 1;
          const previous = groupOf(index);
          while (index > 0 && groupOf(index - 1) === previous) index -= 1;
        }
      }
      setActive(index);
    } else if (event.key === 'Enter') {
      if (active < 0) return;
      event.preventDefault();
      run(rows[active].command);
    } else if (event.key === 'Escape') {
      // Back one page; on the first page the dialog closes (DS.overlay).
      if (pages.length) {
        event.preventDefault();
        leave();
      }
    } else if (event.key === 'Backspace' && !input.value && pages.length && input.selectionStart === 0) {
      event.preventDefault();
      leave();
    }
  }, options);

  // The field keeps focus: a press on the list never takes it.
  list.addEventListener('mousedown', (event) => event.preventDefault(), options);
  list.addEventListener('pointermove', (/** @type {PointerEvent} */ event) => {
    const option = /** @type {Element} */ (event.target).closest?.('.ds-command__item');
    const index = rows.findIndex((row) => row.node === option);
    if (index >= 0 && index !== active) setActive(index, false);
  }, options);
  list.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const option = /** @type {Element} */ (event.target).closest?.('.ds-command__item');
    const row = rows.find((entry) => entry.node === option);
    if (row) run(row.command);
  }, options);
  back.addEventListener('click', () => {
    leave();
    input.focus({ preventScroll: true });
  }, options);
  // Opened by any door (data-ds-open, DS.overlay.open): the first page, an empty field.
  el.addEventListener('ds:open', (event) => {
    if (event.target !== el) return;
    if (!prepared) reset('');
    prepared = false;
    input.focus({ preventScroll: true });
  }, options);
  el.addEventListener('ds:close', (event) => {
    if (event.target !== el) return;
    pending?.abort();
  }, options);

  /* The opening combo: it opens over the page, and closes the open palette. */
  const combo = el.getAttribute('data-ds-command-hotkey') ?? given.hotkey ?? HOTKEY;
  let opening = null;
  if (combo && combo !== 'off') {
    try {
      opening = register(combo, () => {
        const top = topmost(doc);
        if (top === el) closeOverlay(el, { reason: 'hotkey' });
        else if (top) return false;
        else openPalette();
        return undefined;
      }, { description: t('commandOpen'), overlays: true, root: doc });
      for (const button of doc.querySelectorAll(`[data-ds-open="#${el.id}"]`)) {
        if (!button.hasAttribute('aria-keyshortcuts')) button.setAttribute('aria-keyshortcuts', formatCombo(combo).aria);
      }
    } catch (error) {
      view.reportError?.(error);
    }
  }

  function reset(text) {
    pages = [];
    input.value = text;
    query = text.trim();
    remote = [];
    showPage();
    changed();
  }

  function openPalette(openOptions = {}) {
    if (el.getAttribute('data-state') !== 'open') {
      reset(openOptions.query ?? '');
      prepared = true;
    }
    const shown = openOverlay(el, { opener: openOptions.opener ?? doc.activeElement });
    prepared = false;
    input.focus({ preventScroll: true });
    if (openOptions.page) {
      const target = flatten(commands).find((command) => command.id === openOptions.page && command.children);
      if (target) enter(target);
    }
    return shown;
  }

  registerShortcuts();
  showPage();
  paint();

  const api = {
    get() {
      return { open: el.getAttribute('data-state') === 'open', query, page: page()?.command.id ?? null, active: rows[active]?.command.id ?? null };
    },
    set(next = {}) {
      if (Array.isArray(next)) next = { commands: next };
      if (next.commands) {
        commands = next.commands.map(normalize);
        registerShortcuts();
      }
      if (next.providers) providers = next.providers;
      if (typeof next.query === 'string') {
        query = next.query.trim();
        input.value = next.query;
      }
      changed();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    open: (openOptions) => openPalette(openOptions),
    close: () => closeOverlay(el, { reason: 'api' }),
    back: () => leave(),
    run: (id) => run(flatten(commands).find((command) => command.id === id)),
    refresh: () => changed(),
    destroy() {
      // A later create(el) or open(el) makes a new palette, never this dead one.
      made.delete(el);
      for (const handle of shortcuts) handle.destroy();
      shortcuts = [];
      opening?.destroy();
      pending?.abort();
      view.clearTimeout(timer);
      view.clearTimeout(spinnerTimer);
      lifetime.abort();
      back.remove();
      if (listBefore) list.replaceChildren(...listBefore);
      listeners.clear();
      store?.destroy();
    },
  };
  return api;
}

const made = new WeakMap();

/**
 * The palette of `el` (a .ds-dialog.ds-command with its .ds-command__input):
 * the same controller [data-ds-command] makes. `commands` replaces the
 * options of the markup; `providers`, `recent` (how many, 0: none),
 * `hotkey` (the opening combo; data-ds-command-hotkey wins, "off": none)
 * and `shortcuts: false` (do not register the commands' combos). Once per
 * element: a second call returns the same controller with `commands` and
 * `providers` set. Null without the field.
 * @param {Element} el
 * @param {{ commands?: object[], providers?: object[], recent?: number, hotkey?: string, shortcuts?: boolean }} [options]
 */
export function create(el, options = {}) {
  const known = made.get(el);
  if (known) {
    if (options.commands || options.providers) known.set({ commands: options.commands, providers: options.providers });
    return known;
  }
  const palette = controller(el, options);
  if (palette) made.set(el, palette);
  return palette;
}

/**
 * Opens the palette of `el` (made on first use): an empty field on the
 * first page, or `query` typed and `page` (a command id) entered.
 * @param {Element} el
 * @param {{ opener?: Element|null, query?: string, page?: string }} [options]
 * @returns {Promise<void>}
 */
export function open(el, options = {}) {
  return create(el)?.open(options) ?? Promise.resolve();
}

/**
 * Closes the palette of `el` (DS.overlay.close()).
 * @param {Element} el
 * @returns {Promise<void>}
 */
export function close(el) {
  return closeOverlay(el, { reason: 'api' });
}

define('command', {
  attribute: 'data-ds-command',
  init(el, ctx) {
    const known = made.get(el);
    if (known) return known;
    const palette = controller(el, {}, ctx.signal);
    if (!palette) return undefined;
    made.set(el, palette);
    const destroy = palette.destroy;
    palette.destroy = () => {
      made.delete(el);
      destroy();
    };
    return palette;
  },
});
