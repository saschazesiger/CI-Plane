/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Search hits (DS.hits): the hits of a search marked in a text, as
 * <mark class="ds-hit"> around each, ignoring case and accents.
 *
 *   <ul data-ds-hits="toner print">...</ul>          every "toner" and every "print..." marked
 *   <p data-ds-hits="second floor" data-ds-hits-mode="phrase">...</p>
 *   const marks = DS.hits.create(list, { query: 'toner' });   marks.set('cartridge');
 *   DS.hits.ranges('Café au lait', 'cafe');                    [[0, 4]]
 *
 * The query: words apart by spaces, each marked wherever it starts a hit
 * (mode "words", the default), or the whole query as one (mode "phrase").
 * Matching folds case and accents (NFD without combining marks), so "cafe"
 * finds "Café" and the mark covers what the text shows. Hits that touch or
 * overlap are one mark.
 *
 * Only text is marked: not inside <script>, <style>, <textarea>, form
 * fields, existing marks of the page, or anything under
 * [data-ds-hits-skip]. A new query takes the old marks out first (their
 * text is put back and joined). A re-render of the container (DS.dom.morphHtml
 * writes text without marks) is marked again before paint by the
 * container's MutationObserver.
 *
 * The controller: get() gives { query, count }, set(query) marks another
 * query (empty: none), on('change', fn) runs with { query, count }, update()
 * reads the attributes again, destroy() takes every mark out. Events:
 * ds:change after set(). The page announces the count where it matters
 * (DS.a11y.announce): a mark says nothing by itself.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit } from './core.js';

const SKIP = 'script, style, textarea, input, select, option, mark, [data-ds-hits-skip]';

/** `text` folded for matching (lower case, no accents), with the index in `text` of each folded character. */
function fold(text) {
  let folded = '';
  const map = [];
  let index = 0;
  for (const char of text) {
    const plain = char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const unit of plain) {
      folded += unit;
      map.push(index);
    }
    index += char.length;
  }
  map.push(index);
  return { folded, map };
}

/** The terms of a query: its words, or the whole of it as one phrase. */
function terms(query, mode) {
  const text = String(query ?? '').trim();
  if (!text) return [];
  const list = mode === 'phrase' ? [text] : text.split(/\s+/);
  return [...new Set(list.map((term) => fold(term).folded).filter(Boolean))];
}

/**
 * Where the terms of `query` occur in `text`: sorted [start, end) pairs in
 * `text`'s own indices, touching and overlapping hits joined.
 * @param {string} text
 * @param {string} query
 * @param {{ mode?: 'words'|'phrase' }} [options]
 * @returns {[number, number][]}
 */
export function ranges(text, query, options = {}) {
  const wanted = terms(query, options.mode);
  if (!wanted.length || !text) return [];
  const { folded, map } = fold(String(text));
  const found = [];
  for (const term of wanted) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      found.push([map[at], map[at + term.length]]);
      at = folded.indexOf(term, at + 1);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const joined = [];
  for (const range of found) {
    const last = joined.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else joined.push([...range]);
  }
  return joined;
}

/** Takes our marks out of `root`, joining the text around them. */
function unmark(root) {
  const marks = root.querySelectorAll('mark.ds-hit[data-ds-hit]');
  const parents = new Set();
  for (const mark of marks) {
    parents.add(mark.parentNode);
    mark.replaceWith(...mark.childNodes);
  }
  for (const parent of parents) parent?.normalize?.();
}

/** Marks the hits in the text nodes of `root`; returns how many marks. */
function mark(root, query, mode) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) && root.contains(node.parentElement.closest(SKIP)) ? 2 : 1),
  });
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  let count = 0;
  for (const node of nodes) {
    const hits = ranges(node.data, query, { mode });
    if (!hits.length) continue;
    const fragment = doc.createDocumentFragment();
    let from = 0;
    for (const [start, end] of hits) {
      if (start > from) fragment.append(node.data.slice(from, start));
      const element = doc.createElement('mark');
      element.className = 'ds-hit';
      element.setAttribute('data-ds-hit', '');
      element.textContent = node.data.slice(start, end);
      fragment.append(element);
      from = end;
      count += 1;
    }
    if (from < node.data.length) fragment.append(node.data.slice(from));
    node.replaceWith(fragment);
  }
  return count;
}

function controller(el, given) {
  const view = el.ownerDocument?.defaultView ?? globalThis;
  const listeners = new Set();
  let query = given.query ?? el.getAttribute('data-ds-hits') ?? '';
  let count = 0;
  let live = true;
  const mode = () => (given.mode ?? el.getAttribute('data-ds-hits-mode')) === 'phrase' ? 'phrase' : 'words';

  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (live) render();
  }) : null;
  const watch = () => watcher?.observe(el, { childList: true, characterData: true, subtree: true });

  function render() {
    watcher?.disconnect();
    unmark(el);
    count = query.trim() ? mark(el, query, mode()) : 0;
    watcher?.takeRecords();
    if (live) watch();
  }
  render();

  return {
    get() {
      return { query, count };
    },
    set(next) {
      query = String(next ?? '');
      if (el.hasAttribute('data-ds-hits')) {
        watcher?.disconnect();
        el.setAttribute('data-ds-hits', query);
      }
      render();
      const detail = { query, count };
      emit(el, 'change', detail);
      for (const fn of [...listeners]) fn(detail);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      query = el.getAttribute('data-ds-hits') ?? query;
      render();
    },
    destroy() {
      if (!live) return;
      live = false;
      watcher?.disconnect();
      unmark(el);
      listeners.clear();
    },
  };
}

define('hits', {
  attribute: 'data-ds-hits',
  attributes: ['data-ds-hits-mode'],
  init(el) {
    return controller(el, {});
  },
});

/**
 * Marks driven from the page; the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ query?: string, mode?: 'words'|'phrase' }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options);
}
