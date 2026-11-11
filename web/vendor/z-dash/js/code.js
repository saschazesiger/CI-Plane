/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Code block: a .ds-code-block in a .ds-code frame with a header (the file
 * or the language, a wrap toggle and a copy button), line numbers, marked
 * lines, tabs for several files and a height that folds long code behind
 * "Show more".
 *
 *   <figure class="ds-code ds-code--lines" data-ds-code data-ds-code-max="12">
 *     <div class="ds-code__head ds-sm">
 *       <span class="ds-code__title">device.json</span>
 *       <span class="ds-code__lang"></span>
 *       <span class="ds-code__actions">
 *         <button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-ds-code-wrap aria-pressed="false" aria-label="Wrap lines">(wrapText)</button>
 *         <button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-ds-copy aria-label="Copy code">(icon swap)</button>
 *       </span>
 *     </div>
 *     <pre class="ds-code-block" tabindex="0" data-ds-code-lang="json" data-ds-code-mark="2,4-5"><code>...</code></pre>
 *     <div class="ds-code__foot"><button class="ds-btn ds-btn--text" type="button" data-ds-code-expand>...</button></div>
 *   </figure>
 *   const code = DS.code.create(el); code.set(nextSource); code.select(1); code.expand(true); code.wrap(true);
 *
 * What it does with the markup:
 * - Lines: the code of each block (its text) becomes one
 *   <span class="ds-code__line" data-line="n"> per line, highlighted by
 *   DS.highlight when the block names a language (data-ds-code-lang on the
 *   pre, a class language-<x> on the code, else the root's data-ds-code);
 *   each line keeps its line break, so the code's text (and what the copy
 *   button copies) stays the source. data-ds-code-start numbers from
 *   another line, data-ds-code-mark ("2,4-6", the numbers shown) marks
 *   lines (a <mark>), and a diff's + and - lines get their tint. The
 *   numbers show with .ds-code--lines (CSS only).
 * - The header: .ds-code__lang says the language of the shown block
 *   (data-ds-code-label on the pre for another word); a [data-ds-copy]
 *   button copies the shown block (DS.copy reads its code by id); a
 *   [data-ds-code-wrap] toggle wraps every block (aria-pressed), and with
 *   data-ds-code-remember the choice is kept (DS.store, namespace
 *   "code").
 * - Tabs: a role="tablist" in the header (.ds-tabs) with a tab per block
 *   (aria-controls): the arrow keys, Home and End move and select
 *   (automatic activation), the indicator glides, the block swaps in.
 * - Height: data-ds-code-max="<lines>" folds a longer block to that many
 *   lines (data-state="collapsed" on the root); the [data-ds-code-expand]
 *   button (aria-expanded, its .ds-code__expand-label says "Show more" or
 *   "Show less") unfolds it, the height gliding on the tokens.
 *
 * Ownership: what the controller writes (data-state, the ids and names it
 * gives, aria-pressed, aria-expanded, the tabs' state, hidden, the wrap
 * class, --ds-code-max and --ds-code-digits) it claims through
 * DS.dom.own(), so a page that re-renders with DS.dom.morphHtml keeps it;
 * the lines a page writes as linesHtml() writes them patch to nothing (a
 * streamed DS.markdown answer), and get() and refresh() read lines a page
 * changed underneath as the new code.
 *
 * Events on the root: ds:change { code, index } after set(), ds:select
 * { index, panel } after a tab changes, ds:expand { expanded }, ds:wrap
 * { wrap }. The controller: get(), set(code), on(type, fn), select(index),
 * expand(open), wrap(on), refresh(), destroy().
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, runtime, t } from './core.js';
import { disown, morphHtml, own, roving } from './dom.js';
import { enter, motionDuration } from './motion.js';
import { create as makeIndicator } from './indicator.js';
import { open as openStore } from './store.js';
import { language as knownLanguage, lines as highlightLines } from './highlight.js';

const shared = runtime.state('code', () => ({ ids: 0 }));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (text) => text.replace(/[&<>"]/g, (char) => ESCAPES[char]);

/**
 * The line numbers a mark list names ("2,4-6" → 2, 4, 5, 6), as a Set;
 * whitespace allowed, nonsense skipped, a range at most 10,000 long.
 * @param {string|null|undefined} text
 * @returns {Set<number>}
 */
export function parseLines(text) {
  const found = new Set();
  for (const part of String(text ?? '').split(/[,\s]+/)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    for (let line = Math.min(from, to); line <= Math.max(from, to) && line - Math.min(from, to) < 10000; line += 1) found.add(line);
  }
  return found;
}

/**
 * The markup of the lines of `source` (see the header): highlighted when
 * `language` is known (or a page highlighter is set), numbered from
 * `start`, the lines of `marks` in a <mark>. A final line break makes no
 * empty last line.
 * @param {string} source
 * @param {{ language?: string, start?: number, marks?: Set<number> }} [options]
 * @returns {string}
 */
export function linesHtml(source, options = {}) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const lang = options.language ?? '';
  const rows = lang ? highlightLines(text, lang) : text.split('\n').map(escape);
  const raw = lang && knownLanguage(lang) === 'diff' ? text.split('\n') : null;
  const start = Number.isInteger(options.start) ? options.start : 1;
  const marks = options.marks ?? new Set();
  return rows.map((row, index) => {
    const number = start + index;
    const marked = marks.has(number);
    let cls = 'ds-code__line';
    if (marked) cls += ' ds-code__line--mark';
    if (raw && /^\+(?!\+\+)/.test(raw[index])) cls += ' ds-code__line--inserted';
    else if (raw && /^-(?!--)/.test(raw[index])) cls += ' ds-code__line--deleted';
    const tag = marked ? 'mark' : 'span';
    return `<${tag} class="${cls}" data-line="${number}">${row}${index < rows.length - 1 ? '\n' : ''}</${tag}>`;
  }).join('');
}

/** The blocks of a root: its pre.ds-code-block children (or the root itself). */
function blocksOf(root) {
  if (root.matches?.('pre')) return [root];
  // Its own blocks: not those of a frame inside it.
  return Array.from(root.querySelectorAll('pre.ds-code-block')).filter((pre) => pre.parentElement?.closest('[data-ds-code], .ds-code') === root);
}

/** The code element of a block (made when the pre holds text only). */
function codeOf(pre) {
  let code = pre.querySelector(':scope > code');
  if (!code) {
    code = pre.ownerDocument.createElement('code');
    code.textContent = pre.textContent;
    pre.replaceChildren(code);
  }
  return code;
}

function languageOf(pre, code, root) {
  const named = pre.getAttribute('data-ds-code-lang') || code.getAttribute('data-ds-code-lang');
  if (named) return named;
  const cls = /(?:^|\s)lang(?:uage)?-([\w+#.-]+)/.exec(code.className || '');
  if (cls) return cls[1];
  return root.getAttribute('data-ds-code') || '';
}

function controller(root, options, signal) {
  const doc = root.ownerDocument;
  const listeners = new Map();
  const cleanups = [];
  const notify = (type, detail) => {
    if (signal?.aborted) return;
    emit(root, type, detail);
    listeners.get(type)?.forEach((fn) => fn(detail));
  };
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn, signal ? { signal } : undefined);
    if (!signal) cleanups.push(() => target.removeEventListener(type, fn));
  };

  // What this controller writes, claimed so a DS.dom.morphHtml of the page (a streamed Markdown answer) keeps it.
  const claims = [];
  const claim = (el, kind, ...names) => {
    for (const name of names) {
      own(el, kind, name);
      claims.push([el, kind, name]);
    }
  };
  claim(root, 'attrs', 'data-state');
  claim(root, 'props', '--ds-code-max');

  const panels = blocksOf(root).map((pre) => {
    const code = codeOf(pre);
    if (!code.id) {
      shared.ids += 1;
      code.id = `ds-code-${shared.ids}`;
      claim(code, 'attrs', 'id');
    }
    claim(pre, 'attrs', 'aria-labelledby', 'hidden', 'id');
    claim(pre, 'props', '--ds-code-digits');
    claim(pre, 'classes', 'ds-code-block--wrap');
    return { pre, code, source: code.textContent ?? '' };
  });
  if (options.code !== undefined && panels[0]) panels[0].source = String(options.code);

  /**
   * The page may change the lines underneath (a streamed DS.markdown answer morphs the frame): when the text is no
   * longer what the last render wrote, the text is the source again.
   */
  const sync = (panel) => {
    if (panel.text !== undefined && panel.code.textContent !== panel.text) panel.source = panel.code.textContent;
  };

  const tablist = root.querySelector('[role="tablist"]');
  const tabs = tablist ? Array.from(tablist.querySelectorAll('[role="tab"]')) : [];
  const tabOf = (panel) => tabs.find((tab) => tab.getAttribute('aria-controls') === panel.pre.id) ?? null;
  let index = Math.max(0, panels.findIndex((panel) => !panel.pre.hidden));
  const active = () => panels[index];

  const render = (panel) => {
    const lang = languageOf(panel.pre, panel.code, root);
    const start = Number.parseInt(panel.pre.getAttribute('data-ds-code-start') ?? root.getAttribute('data-ds-code-start') ?? '1', 10);
    const marks = parseLines(panel.pre.getAttribute('data-ds-code-mark') ?? (panels.length === 1 ? root.getAttribute('data-ds-code-mark') : null));
    const first = Number.isInteger(start) ? start : 1;
    morphHtml(panel.code, linesHtml(panel.source, { language: lang, start: first, marks }));
    panel.text = panel.code.textContent;
    const count = panel.code.childElementCount;
    panel.lines = count;
    panel.pre.style.setProperty('--ds-code-digits', String(String(first + Math.max(count, 1) - 1).length));
    panel.lang = lang;
  };

  /* The header: language label and copy target follow the shown block. */
  const label = root.querySelector('.ds-code__lang');
  const copyButton = root.querySelector('[data-ds-copy]');
  if (label) claim(label, 'attrs', 'id', 'hidden');
  if (copyButton) claim(copyButton, 'attrs', 'data-ds-copy');
  const ownCopy = copyButton && (!copyButton.getAttribute('data-ds-copy') || panels.some((panel) => copyButton.getAttribute('data-ds-copy') === `#${panel.code.id}`));
  const head = () => {
    const panel = active();
    if (!panel) return;
    if (label) {
      const word = panel.pre.getAttribute('data-ds-code-label') ?? panel.lang ?? '';
      if (label.textContent !== word) label.textContent = word;
      label.hidden = !word;
    }
    if (ownCopy) copyButton.setAttribute('data-ds-copy', `#${panel.code.id}`);
    // A block that scrolls is a stop of its own; it needs a name.
    if (!panel.pre.hasAttribute('aria-label') && !panel.pre.hasAttribute('aria-labelledby')) {
      const named = tabOf(panel) ?? root.querySelector('.ds-code__title') ?? (label && !label.hidden ? label : null);
      if (named) {
        claim(named, 'attrs', 'id');
        if (!named.id) {
          shared.ids += 1;
          named.id = `ds-code-name-${shared.ids}`;
        }
        panel.pre.setAttribute('aria-labelledby', named.id);
      }
    }
  };

  /* Height: fold a long block to data-ds-code-max lines. */
  const expandButton = root.querySelector('[data-ds-code-expand]');
  const expandLabel = expandButton?.querySelector('.ds-code__expand-label');
  if (expandButton) claim(expandButton, 'attrs', 'aria-expanded', 'aria-controls');
  let expanded = false;
  let finishHeight = null;
  const maxLines = () => {
    const value = Number.parseInt(root.getAttribute('data-ds-code-max') ?? '', 10);
    return Number.isInteger(value) && value > 0 ? value : 0;
  };
  const writeState = () => {
    const max = maxLines();
    const folds = max > 0 && (active()?.lines ?? 0) > max;
    if (folds) {
      root.style.setProperty('--ds-code-max', String(max));
      root.setAttribute('data-state', expanded ? 'expanded' : 'collapsed');
    } else {
      root.removeAttribute('data-state');
      root.style.removeProperty('--ds-code-max');
    }
    if (expandButton) {
      expandButton.setAttribute('aria-expanded', String(expanded));
      if (active()) expandButton.setAttribute('aria-controls', active().pre.id || (active().pre.id = `${active().code.id}-block`));
      const words = t(expanded ? 'showLess' : 'showMore');
      if (expandLabel && expandLabel.textContent !== words) expandLabel.textContent = words;
    }
  };
  const glide = (pre, change) => {
    // From where it is now, mid-glide too: measured before the last glide lets go.
    const from = pre.getBoundingClientRect().height;
    finishHeight?.(null, true);
    pre.style.height = `${from}px`;
    change();
    // The target: every line, or the folded lines and the top padding (code.css).
    const style = doc.defaultView.getComputedStyle(pre);
    const folded = root.getAttribute('data-state') === 'collapsed';
    const to = folded
      ? maxLines() * Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop)
      : pre.scrollHeight + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    void pre.offsetHeight;
    pre.style.height = `${to}px`;
    let timer = 0;
    const done = (event, keep = false) => {
      if (event && (event.target !== pre || event.propertyName !== 'height')) return;
      pre.removeEventListener('transitionend', done);
      globalThis.clearTimeout(timer);
      if (!keep) pre.style.removeProperty('height');
      if (finishHeight === done) finishHeight = null;
    };
    finishHeight = done;
    pre.addEventListener('transitionend', done);
    // A zero duration (or no transition at all) sends no transitionend: the timer finishes then.
    timer = globalThis.setTimeout(done, motionDuration(pre, folded ? '--ds-dur-base' : '--ds-dur-medium') + motionDuration(pre, '--ds-dur-fast'));
  };
  const setExpanded = (open, animate = true) => {
    const next = Boolean(open);
    if (next === expanded) return;
    const pre = active()?.pre;
    const apply = () => {
      expanded = next;
      writeState();
    };
    if (animate && pre && root.hasAttribute('data-state') && pre.isConnected) glide(pre, apply);
    else apply();
    notify('expand', { expanded });
  };

  /* Wrap. */
  const wrapButton = root.querySelector('[data-ds-code-wrap]');
  if (wrapButton) claim(wrapButton, 'attrs', 'aria-pressed', 'aria-label');
  const remember = root.getAttribute('data-ds-code-remember');
  const store = remember ? openStore('code') : null;
  let wrapping = panels.some((panel) => panel.pre.classList.contains('ds-code-block--wrap'));
  if (store) wrapping = store.get(`${remember}.wrap`, wrapping) === true;
  const writeWrap = () => {
    for (const panel of panels) panel.pre.classList.toggle('ds-code-block--wrap', wrapping);
    if (wrapButton) {
      wrapButton.setAttribute('aria-pressed', String(wrapping));
      if (!wrapButton.hasAttribute('aria-label') && !wrapButton.hasAttribute('aria-labelledby') && !wrapButton.textContent.trim()) wrapButton.setAttribute('aria-label', t('wrapLines'));
    }
  };
  const setWrap = (on) => {
    const next = Boolean(on);
    if (next === wrapping) return;
    wrapping = next;
    writeWrap();
    store?.set(`${remember}.wrap`, wrapping);
    notify('wrap', { wrap: wrapping });
  };

  /* Tabs. */
  let indicator = null;
  let rover = null;
  const select = (next, focus = false) => {
    if (!Number.isInteger(next) || next < 0 || next >= panels.length) return;
    const tab = tabOf(panels[next]);
    if (tab?.getAttribute('aria-disabled') === 'true') return;
    const changed = next !== index;
    index = next;
    panels.forEach((panel, at) => {
      const shown = at === index;
      const own = tabOf(panel);
      if (own) {
        own.setAttribute('aria-selected', String(shown));
        own.tabIndex = shown ? 0 : -1;
      }
      if (panel.pre.hidden === shown) {
        panel.pre.hidden = !shown;
        if (shown && changed) enter(panel.pre, 'swap');
      }
    });
    head();
    writeState();
    if (focus) tab?.focus();
    if (changed) notify('select', { index, panel: panels[index].pre });
  };
  for (const tab of tabs) claim(tab, 'attrs', 'aria-selected', 'tabindex');
  if (tablist && tabs.length) {
    indicator = makeIndicator(tablist, { active: '[aria-selected="true"]', className: 'ds-tabs__indicator', reveal: true });
    rover = roving(tablist, { onActivate: (tab) => select(panels.findIndex((panel) => tabOf(panel) === tab)) });
    listen(tablist, 'click', (event) => {
      const tab = event.target.closest?.('[role="tab"]');
      if (!tab || !tablist.contains(tab)) return;
      select(panels.findIndex((panel) => tabOf(panel) === tab));
    });
  }

  if (wrapButton) listen(wrapButton, 'click', () => setWrap(!wrapping));
  if (expandButton) listen(expandButton, 'click', () => setExpanded(!expanded));

  panels.forEach(render);
  writeWrap();
  select(index);
  writeState();

  return {
    get() {
      const panel = active();
      if (!panel) return '';
      sync(panel);
      return panel.source;
    },
    set(next) {
      const panel = active();
      if (!panel) return;
      sync(panel);
      const text = String(next ?? '');
      if (text === panel.source) return;
      panel.source = text;
      render(panel);
      writeState();
      notify('change', { code: text, index });
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    select(next) { select(next); },
    expand(open = true) { setExpanded(open); },
    wrap(on = true) { setWrap(on); },
    /** Reads the blocks' attributes again (language, start, marks, max) and renders. */
    refresh() {
      panels.forEach(sync);
      panels.forEach(render);
      head();
      writeState();
    },
    update() { this.refresh(); },
    destroy() {
      finishHeight?.(null);
      indicator?.destroy?.();
      rover?.destroy?.();
      cleanups.forEach((fn) => fn());
      for (const [el, kind, name] of claims) disown(el, kind, name);
      listeners.clear();
    },
  };
}

define('code', {
  attribute: 'data-ds-code',
  attributes: ['data-ds-code-max', 'data-ds-code-start', 'data-ds-code-mark'],
  init(el, ctx) {
    return controller(el, {}, ctx.signal);
  },
});

/**
 * A code block driven from the page: the same controller data-ds-code
 * makes. `code` replaces the first block's text.
 * @param {Element} el
 * @param {{ code?: string }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options, null);
}
