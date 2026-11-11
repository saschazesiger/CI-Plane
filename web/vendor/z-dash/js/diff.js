/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Diff view (DS.diff): unified diff text (git diff, diff -u) shown as files
 * with their headers, hunks, two line-number gutters and word-level marks,
 * unified or side by side, long runs of unchanged lines folded.
 *
 *   <div class="ds-diff" data-ds-diff data-ds-diff-view="split" aria-label="Changes">
 *     <pre class="ds-diff__source">diff --git a/src/app.js b/src/app.js ...</pre>
 *   </div>
 *   const view = DS.diff.create(el, { text, view: 'unified', context: 3 });
 *   view.set({ view: 'split' });  view.get().files;  view.expand();
 *   DS.diff.parse(text);           the files, hunks and lines as data
 *   DS.diff.words(before, after);  the changed ranges of two lines
 *   DS.diff.rows(file, options);   the rows a view shows, folds included
 *   DS.diff.highlighter(fn);       the page's syntax highlighter
 *
 * The attribute path reads the text of .ds-diff__source (kept in the page,
 * hidden once rendered, so the diff reads as text before the script runs and
 * a re-render of the page that changes it renders again) and the options
 * data-ds-diff-view (unified, default; split; auto: split from
 * --ds-diff-split-min of the element's width, else unified),
 * data-ds-diff-context (unchanged lines kept around a change before the rest
 * folds, default 3; "all" never folds), data-ds-diff-lang (the language of
 * every file; default each file's extension) and data-ds-diff-heading (the
 * level of the file headings, default 3).
 *
 * Rendering: the files go into a .ds-diff__files element of the component's
 * own, through DS.dom.morphHtml, so a re-render keeps the focus and what was
 * unfolded. Every text is escaped; the markup of a highlighter is taken as
 * it comes (the page chose it). Word marks (ins and del) are laid over the
 * highlighted markup by character, closed and opened again around its tags.
 *
 * Highlighting: highlighter(fn) sets the page's highlighter, fn(code,
 * language) returning the markup of one line; the option `highlight` sets
 * one for a single view (false: none). Without either, DS.highlight.highlight
 * of ds.js is used when the page has it, else the code stays plain.
 *
 * Folding: a run of unchanged lines inside a hunk that would hide at least
 * four lines beyond `context` on each side folds into a button ("Show 12
 * unchanged lines"). The lines between two hunks (or above the first) are
 * not in the diff: with the option `load({ file, path, from, to })` (old-side
 * line numbers, a list of lines or a promise of one) the hunk header offers
 * them. A revealed run takes the focus at its first row and is announced.
 *
 * Large diffs: a file above LARGE_FILE lines in its hunks starts folded,
 * and a folded file renders no rows. A toggle, a fold or loaded lines render
 * their file alone, and the word marks of a pair of lines are computed once
 * per text.
 *
 * Events on the element: ds:change { view, text } after set(), ds:expand
 * { file, count } after a fold opened.
 *
 * ES2022. Progressive: none.
 */
import { define, emit, runtime, t } from './core.js';
import { morphHtml } from './dom.js';
import { announce } from './a11y.js';
import { icon, chevronDown, expandAll, arrowRight } from './icons.js';

/** The page-wide state: the page's highlighter, the numbering of ids, the live views. */
const shared = runtime.state('diff', () => ({ highlight: null, ids: 0, views: new Set() }));

/** Lines a fold must hide at least, beyond the kept context. */
const MIN_FOLD = 4;

/** Above this many token pairs a line pair gets no word marks (one long minified line). */
const MAX_WORD_CELLS = 250000;

/** Two lines that share less than this of their text are a rewrite: no word marks. */
const MIN_SHARED = 0.35;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (char) => ESCAPES[char]);

/* ── Parsing ────────────────────────────────────────── */

/** A path of a header line: quotes and the a/ b/ prefix off, a trailing timestamp (diff -u) off. */
function cleanPath(raw, prefix) {
  let path = String(raw ?? '').replace(/\t.*$/, '').trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, '$1');
  if (path === '/dev/null') return null;
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
  return path;
}

/** The two paths of a "diff --git a/x b/y" line (the two halves are equal unless renamed). */
function gitPaths(rest) {
  const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return [quoted[1], quoted[2]];
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2)) return [rest.slice(2, half), rest.slice(half + 3)];
  const split = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return split ? [split[1], split[2]] : [rest, rest];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Unified diff text as data: a list of files, each
 * `{ oldPath, newPath, path, status, binary, additions, deletions, hunks }`;
 * status is modified, added, deleted, renamed or copied; a hunk is
 * `{ oldStart, oldLines, newStart, newLines, section, lines }` and a line
 * `{ kind: 'ctx'|'add'|'del', text, old, new, noNewline }` (old and new are
 * the line numbers on each side, null where the line is not). Lines outside a
 * file (a commit message before it) are left out.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parse(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldAt = 0;
  let newAt = 0;
  const begin = (oldPath = null, newPath = null) => {
    file = { oldPath, newPath, path: '', status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
    files.push(file);
    hunk = null;
  };
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = line.charAt(0);
      if (sign === '+' && newLeft > 0) {
        hunk.lines.push({ kind: 'add', text: line.slice(1), old: null, new: newAt, noNewline: false });
        newAt += 1;
        newLeft -= 1;
        file.additions += 1;
        continue;
      }
      if (sign === '-' && oldLeft > 0) {
        hunk.lines.push({ kind: 'del', text: line.slice(1), old: oldAt, new: null, noNewline: false });
        oldAt += 1;
        oldLeft -= 1;
        file.deletions += 1;
        continue;
      }
      // A context line; some tools strip the space of an empty one.
      if ((sign === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: 'ctx', text: line.slice(1), old: oldAt, new: newAt, noNewline: false });
        oldAt += 1;
        newAt += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
    }
    if (line.startsWith('\\')) {
      const last = hunk?.lines.at(-1);
      if (last) last.noNewline = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [oldPath, newPath] = gitPaths(line.slice(11));
      begin(oldPath, newPath);
      continue;
    }
    const range = HUNK.exec(line);
    if (range) {
      if (!file) begin();
      hunk = {
        oldStart: Number(range[1]),
        oldLines: range[2] === undefined ? 1 : Number(range[2]),
        newStart: Number(range[3]),
        newLines: range[4] === undefined ? 1 : Number(range[4]),
        section: range[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      oldAt = hunk.oldStart;
      newAt = hunk.newStart;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A plain diff -u of several files has no "diff" line between them.
      if (!file || file.hunks.length || file.sawOld) begin();
      file.sawOld = true;
      file.oldPath = cleanPath(line.slice(4), 'a/');
      if (file.oldPath === null) file.status = 'added';
      continue;
    }
    if (line.startsWith('+++ ') && file) {
      file.newPath = cleanPath(line.slice(4), 'b/');
      if (file.newPath === null) file.status = 'deleted';
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) [file.status, file.oldPath] = ['renamed', line.slice(12)];
    else if (line.startsWith('rename to ')) [file.status, file.newPath] = ['renamed', line.slice(10)];
    else if (line.startsWith('copy from ')) [file.status, file.oldPath] = ['copied', line.slice(10)];
    else if (line.startsWith('copy to ')) [file.status, file.newPath] = ['copied', line.slice(8)];
    else if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') file.binary = true;
  }
  for (const each of files) {
    delete each.sawOld;
    if (each.status === 'added') each.oldPath = null;
    if (each.status === 'deleted') each.newPath = null;
    if (each.status === 'modified' && each.oldPath && each.newPath && each.oldPath !== each.newPath) each.status = 'renamed';
    each.path = each.newPath ?? each.oldPath ?? '';
  }
  return files;
}

/* ── Word marks ─────────────────────────────────────── */

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** The changed ranges of `tokens` (by `kept`, the indices in the common subsequence) as [start, end) offsets, joined across whitespace. */
function ranges(tokens, kept) {
  const out = [];
  let at = 0;
  tokens.forEach((token, index) => {
    const end = at + token.length;
    if (!kept.has(index)) {
      const last = out.at(-1);
      if (last && last[1] === at) last[1] = end;
      else out.push([at, end]);
    }
    at = end;
  });
  // Whitespace alone between two changes belongs to them; whitespace at either end does not.
  const text = tokens.join('');
  const joined = [];
  for (const range of out) {
    const last = joined.at(-1);
    if (last && /^\s*$/.test(text.slice(last[1], range[0]))) last[1] = range[1];
    else joined.push([...range]);
  }
  return joined
    .map(([start, end]) => {
      const part = text.slice(start, end);
      return [start + (part.length - part.trimStart().length), end - (part.length - part.trimEnd().length)];
    })
    .filter(([start, end]) => end > start);
}

/**
 * The words that changed between two versions of a line: `{ removed, added }`,
 * each a list of [start, end) character ranges in `before` and `after`. Null
 * when the lines are too different to mark (less than about a third shared)
 * or too long to compare, so the whole line stands for the change.
 * @param {string} before
 * @param {string} after
 * @returns {{ removed: Array<[number, number]>, added: Array<[number, number]> } | null}
 */
export function words(before, after) {
  const a = String(before ?? '').match(TOKEN) ?? [];
  const b = String(after ?? '').match(TOKEN) ?? [];
  if (!a.length || !b.length || a.length * b.length > MAX_WORD_CELLS) return null;
  // The longest common subsequence of the tokens, by rows of lengths.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const keptA = new Set();
  const keptB = new Set();
  let common = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      keptA.add(i);
      keptB.add(j);
      if (/\S/.test(a[i])) common += a[i].length;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
    else j += 1;
  }
  const visible = (tokens) => tokens.reduce((sum, token) => sum + (/\S/.test(token) ? token.length : 0), 0);
  const longest = Math.max(visible(a), visible(b));
  if (!longest || common / longest < MIN_SHARED) return null;
  return { removed: ranges(a, keptA), added: ranges(b, keptB) };
}

/**
 * Lays `marks` ([start, end) in characters of the text) over `html`, markup
 * whose text is that line: each run in a `<tag class="ds-diff__word">`,
 * closed before every tag of the markup and opened again after it, so the
 * nesting stays whole. An entity counts as one character.
 */
function markUp(html, marks, tag) {
  if (!marks?.length) return html;
  const open = `<${tag} class="ds-diff__word">`;
  const close = `</${tag}>`;
  let out = '';
  let at = 0;
  let inside = false;
  let range = 0;
  const within = () => {
    while (range < marks.length && marks[range][1] <= at) range += 1;
    return range < marks.length && marks[range][0] <= at;
  };
  for (const piece of html.match(/<[^>]*>|&[^;\s]*;|[^<&]+|[<&]/g) ?? []) {
    if (piece.charAt(0) === '<' && piece.length > 1) {
      if (inside) out += close;
      out += piece;
      if (inside) out += open;
      continue;
    }
    const units = piece.charAt(0) === '&' && piece.length > 1 ? [piece] : Array.from(piece);
    for (const unit of units) {
      const now = within();
      if (now !== inside) {
        out += now ? open : close;
        inside = now;
      }
      out += unit;
      at += unit.charAt(0) === '&' && unit.length > 1 ? 1 : unit.length;
    }
  }
  if (inside) out += close;
  // An empty pair left by a tag at a run's edge.
  return out.split(`${open}${close}`).join('');
}

/* ── Rows ───────────────────────────────────────────── */

/** The word marks of each pair of parsed lines, computed once: a re-render, a fold or a view switch reuses them. */
const pairMarks = new WeakMap();

/** words() of a removed and an added line, from the cache of the pair. */
function pairWords(removed, added) {
  let byAdded = pairMarks.get(removed);
  if (!byAdded) pairMarks.set(removed, (byAdded = new WeakMap()));
  if (!byAdded.has(added)) byAdded.set(added, words(removed.text, added.text));
  return byAdded.get(added);
}

/** The marked lines of each hunk's list of lines, so a render reuses them. */
const markedLines = new WeakMap();

/** The lines of a hunk with the word marks of each changed pair (the i-th removal against the i-th addition of a block). */
function marked(lines) {
  const cached = markedLines.get(lines);
  if (cached) return cached;
  const out = lines.map((line) => ({ ...line, marks: null }));
  for (let at = 0; at < out.length;) {
    if (out[at].kind !== 'del' && out[at].kind !== 'add') {
      at += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (at < out.length && out[at].kind === 'del') dels.push(at++);
    while (at < out.length && out[at].kind === 'add') adds.push(at++);
    for (let i = 0; i < Math.min(dels.length, adds.length); i += 1) {
      const change = pairWords(lines[dels[i]], lines[adds[i]]);
      if (!change) continue;
      out[dels[i]].marks = change.removed;
      out[adds[i]].marks = change.added;
    }
  }
  markedLines.set(lines, out);
  return out;
}

/**
 * The rows a view shows for one parsed file: `{ type: 'hunk', hunk, index,
 * gap }` (gap: the unshown lines above it, with `from` and `to` on the old
 * side and `count`, or null), `{ type: 'line', line }` (unified),
 * `{ type: 'pair', left, right }` (split; a side is a line or null),
 * `{ type: 'fold', key, count, lines }` (lines folded away) and
 * `{ type: 'note' }` (no newline at the end, after its line). `expanded`
 * holds the keys of folds already opened.
 * @param {object} file  one entry of parse()
 * @param {{ view?: 'unified'|'split', context?: number|'all', expanded?: Set<string>|string[] }} [options]
 * @returns {Array<object>}
 */
export function rows(file, options = {}) {
  const split = options.view === 'split';
  const context = options.context === 'all' ? Infinity : Math.max(0, Number(options.context ?? 3) || 0);
  const expanded = new Set(options.expanded ?? []);
  const out = [];
  let oldEnd = 1;
  file.hunks.forEach((hunk, index) => {
    const gapCount = hunk.oldStart - oldEnd - (hunk.oldLines === 0 ? -1 : 0);
    const gap = gapCount > 0 ? { from: oldEnd, to: oldEnd + gapCount - 1, count: gapCount, key: `g${index}` } : null;
    out.push({ type: 'hunk', hunk, index, gap });
    oldEnd = hunk.oldStart + hunk.oldLines + (hunk.oldLines === 0 ? 1 : 0);
    const lines = marked(hunk.lines);
    const show = (line) => {
      out.push(split ? { type: 'pair', left: line, right: line } : { type: 'line', line });
      if (line.noNewline) out.push({ type: 'note' });
    };
    for (let at = 0; at < lines.length;) {
      let end = at;
      if (lines[at].kind === 'ctx') {
        while (end < lines.length && lines[end].kind === 'ctx') end += 1;
        const run = lines.slice(at, end);
        const head = at === 0 ? 0 : context;
        const tail = end === lines.length ? 0 : context;
        const hidden = run.length - head - tail;
        // Keyed by the old-side number of the run's first line: lines loaded above the hunk shift no other fold.
        const key = `f${index}:o${run[0].old}`;
        if (hidden >= MIN_FOLD && !expanded.has(key)) {
          run.slice(0, head).forEach(show);
          out.push({ type: 'fold', key, count: hidden, lines: run.slice(head, head + hidden) });
          run.slice(head + hidden).forEach(show);
        } else run.forEach(show);
        at = end;
        continue;
      }
      while (end < lines.length && lines[end].kind !== 'ctx') end += 1;
      const block = lines.slice(at, end);
      if (split) {
        const dels = block.filter((line) => line.kind === 'del');
        const adds = block.filter((line) => line.kind === 'add');
        for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) out.push({ type: 'pair', left: dels[i] ?? null, right: adds[i] ?? null });
        if (block.some((line) => line.noNewline)) out.push({ type: 'note' });
      } else block.forEach(show);
      at = end;
    }
  });
  return out;
}

/* ── Rendering ──────────────────────────────────────── */

/** The language of a path, by its extension (the highlighter resolves aliases). */
function languageOf(path) {
  const name = String(path ?? '').split('/').pop() ?? '';
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The highlighter in force for a view: its own, else the page's, else DS.highlight of ds.js, else none. */
function highlighterOf(own) {
  if (own === false) return null;
  if (typeof own === 'function') return own;
  if (typeof shared.highlight === 'function') return shared.highlight;
  const external = globalThis.DS?.highlight?.highlight;
  return typeof external === 'function' ? external : null;
}

/** The markup of one line of code: highlighted (or escaped), with its word marks. */
function codeOf(line, view) {
  if (!line) return '';
  let html = esc(line.text);
  if (view.highlight && line.text) {
    try {
      const out = view.highlight(line.text, view.language);
      if (typeof out === 'string') html = out;
    } catch (error) {
      globalThis.reportError?.(error);
    }
  }
  return markUp(html, line.marks, line.kind === 'add' ? 'ins' : 'del');
}

const SIGN_WORD = { add: 'diffAdded', del: 'diffRemoved' };

/** The cells of one side of a line: its number(s), its sign and its code. */
function cells(line, view, split) {
  const kind = line ? line.kind : 'empty';
  const word = SIGN_WORD[kind] ? `<span class="ds-sr">${esc(t(SIGN_WORD[kind]))}</span>` : '';
  const number = (value) => `<td class="ds-diff__num" data-kind="${kind}"${value === null || value === undefined ? '' : ` data-line="${value}"`}></td>`;
  const numbers = split ? number(line ? (line.kind === 'add' ? line.new : line.old) : null) : number(line.old) + number(line.new);
  return `${numbers}<td class="ds-diff__sign" data-kind="${kind}">${word}</td><td class="ds-diff__code" data-kind="${kind}">${codeOf(line, view)}</td>`;
}

/** The markup of one row model. */
function rowHtml(row, view, file, fileIndex, columns) {
  if (row.type === 'line') return `<tr class="ds-diff__line" data-ds-key="${row.line.kind}${row.line.old ?? ''}:${row.line.new ?? ''}">${cells(row.line, view, false)}</tr>`;
  if (row.type === 'pair') {
    const key = `p${row.left?.old ?? ''}:${row.right?.new ?? ''}:${row.left?.kind ?? ''}${row.right?.kind ?? ''}`;
    return `<tr class="ds-diff__line" data-ds-key="${key}">${cells(row.left, view, true)}${cells(row.right, view, true)}</tr>`;
  }
  if (row.type === 'note') return `<tr class="ds-diff__note"><td colspan="${columns}">${esc(t('diffNoNewline'))}</td></tr>`;
  if (row.type === 'fold') {
    const label = esc(t(row.count === 1 ? 'diffExpandOne' : 'diffExpand', { count: row.count }));
    return `<tr class="ds-diff__fold" data-ds-key="${row.key}"><td colspan="${columns}"><button class="ds-btn ds-btn--quiet ds-sm ds-diff__expand" type="button" data-ds-diff-fold="${fileIndex}|${row.key}">${icon(expandAll, 16)}${label}</button></td></tr>`;
  }
  // A hunk header, with the lines above it when the page can load them.
  const { hunk, gap } = row;
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const gapKey = gap && `${fileIndex}|${gap.key}`;
  const loading = gap && view.loading.has(gapKey);
  const more = gap && view.load && !view.loaded.has(gapKey)
    ? `<button class="ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-diff__expand" type="button" data-ds-diff-gap="${gapKey}" aria-label="${esc(t(gap.count === 1 ? 'diffExpandOne' : 'diffExpand', { count: gap.count }))}"${loading ? ' aria-busy="true"' : ''}>${icon(expandAll, 16)}</button>`
    : '';
  const section = hunk.section ? ` <span class="ds-diff__section">${esc(hunk.section)}</span>` : '';
  return `<tr class="ds-diff__hunk" data-ds-key="h${row.index}"><td colspan="${columns}"><span class="ds-diff__hunk-head">${more}<span class="ds-diff__range">${esc(range)}</span>${section}</span></td></tr>`;
}

/** The rows of a file once the lines loaded between hunks are in: they read as unchanged lines in front of their hunk. */
function withLoaded(file, view, fileIndex) {
  if (!view.loaded.size) return file;
  const hunks = file.hunks.map((hunk, index) => {
    const lines = view.loaded.get(`${fileIndex}|g${index}`);
    if (!lines) return hunk;
    const offset = hunk.newStart - hunk.oldStart;
    const from = hunk.oldStart - lines.length;
    const before = lines.map((text, at) => ({ kind: 'ctx', text, old: from + at, new: from + at + offset, noNewline: false }));
    return { ...hunk, oldStart: from, newStart: from + offset, oldLines: hunk.oldLines + before.length, newLines: hunk.newLines + before.length, lines: [...before, ...hunk.lines] };
  });
  return { ...file, hunks };
}

const STATUS_WORD = { added: 'diffFileAdded', deleted: 'diffFileDeleted', renamed: 'diffFileRenamed', copied: 'diffFileCopied' };

/** Above this many lines in its hunks, a file starts folded: its table renders once the reader opens it. */
const LARGE_FILE = 1000;

/** The lines of a file's hunks. */
const lineCount = (file) => file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);

/** The markup of one file: its section around fileInner(). */
function fileHtml(file, fileIndex, view) {
  return `<section class="ds-diff__file" data-ds-key="${esc(`${fileIndex}:${file.path}`)}">${fileInner(file, fileIndex, view)}</section>`;
}

/** The content of one file's section: its header and its table (none while the file is folded). */
function fileInner(file, fileIndex, view) {
  const id = `${view.id}-${fileIndex}`;
  const folded = view.folded.has(fileIndex);
  const name = file.status === 'renamed' || file.status === 'copied'
    ? `<span class="ds-diff__path ds-diff__path--old">${esc(file.oldPath)}</span>${icon(arrowRight, 16, 'ds-diff__arrow')}<span class="ds-sr"> → </span><span class="ds-diff__path">${esc(file.newPath)}</span>`
    : `<span class="ds-diff__path">${esc(file.path || t('diffUntitled'))}</span>`;
  const status = STATUS_WORD[file.status] || file.binary
    ? `<span class="ds-diff__status">${esc(t(STATUS_WORD[file.status] ?? 'diffFileBinary'))}</span>`
    : '';
  const stat = `<span class="ds-diff__stat"><span class="ds-diff__count" data-kind="add" aria-hidden="true">+${file.additions}</span><span class="ds-diff__count" data-kind="del" aria-hidden="true">−${file.deletions}</span><span class="ds-sr">${esc(t('diffStats', { added: file.additions, removed: file.deletions }))}</span></span>`;
  const level = view.heading;
  const head = `<div class="ds-diff__head"><button class="ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-diff__toggle" type="button" aria-expanded="${!folded}" aria-controls="${id}-body" aria-labelledby="${id}-name">${icon(chevronDown, 18, 'ds-chevron')}</button><h${level} class="ds-diff__name" id="${id}-name">${name}</h${level}>${status}${stat}</div>`;
  let body;
  if (file.binary || !file.hunks.length) {
    body = `<p class="ds-diff__empty">${esc(t(file.binary ? 'diffBinary' : 'diffNoChanges'))}</p>`;
  } else if (folded) {
    // A folded file costs nothing: its rows render when it opens.
    body = '';
  } else {
    const split = view.mode === 'split';
    const columns = split ? 6 : 4;
    const shown = withLoaded(file, view, fileIndex);
    const list = rows(shown, { view: view.mode, context: view.context, expanded: [...view.expanded].filter((key) => key.startsWith(`${fileIndex}|`)).map((key) => key.slice(key.indexOf('|') + 1)) });
    const highest = shown.hunks.reduce((max, hunk) => Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines), 1);
    const th = (key, cls) => `<th scope="col" class="${cls}"><span class="ds-sr">${esc(t(key))}</span></th>`;
    const heads = split
      ? th('diffOldLine', 'ds-diff__num') + th('diffChange', 'ds-diff__sign') + th('diffOldCode', 'ds-diff__code') + th('diffNewLine', 'ds-diff__num') + th('diffChange', 'ds-diff__sign') + th('diffNewCode', 'ds-diff__code')
      : th('diffOldLine', 'ds-diff__num') + th('diffNewLine', 'ds-diff__num') + th('diffChange', 'ds-diff__sign') + th('diffCode', 'ds-diff__code');
    body = `<table class="ds-diff__table" data-view="${split ? 'split' : 'unified'}" style="--ds-diff-digits: ${String(highest).length}"><thead class="ds-diff__cols"><tr>${heads}</tr></thead><tbody>${list.map((row) => rowHtml(row, view, file, fileIndex, columns)).join('')}</tbody></table>`;
  }
  const region = file.binary || !file.hunks.length ? '' : ` tabindex="0" role="region" aria-labelledby="${id}-name"`;
  // One landmark per file: the body is the named region; the section around it stays unnamed (no second region).
  return `${head}<div class="ds-diff__body" id="${id}-body"${region}${folded ? ' hidden' : ''}>${body}</div>`;
}

/* ── The controller ─────────────────────────────────── */

const VIEWS = new Set(['unified', 'split', 'auto']);

function readOptions(el) {
  const context = el.getAttribute('data-ds-diff-context');
  const heading = headingOf(el.getAttribute('data-ds-diff-heading'));
  return {
    view: el.getAttribute('data-ds-diff-view') ?? undefined,
    context: context === null ? undefined : context === 'all' ? 'all' : Number(context),
    language: el.getAttribute('data-ds-diff-lang') ?? undefined,
    heading: heading ?? undefined,
  };
}

/** A heading level 2-6 (it goes into the markup as h<level>), else null. */
function headingOf(value) {
  const level = typeof value === 'number' ? value : Number(value);
  return value !== null && value !== '' && Number.isInteger(level) && level >= 2 && level <= 6 ? level : null;
}

/** The px value of a length custom property on an element (px, rem or em), or null. */
function lengthOf(el, name) {
  const view = el.ownerDocument?.defaultView;
  if (!view) return null;
  const raw = view.getComputedStyle(el).getPropertyValue(name).trim();
  const match = /^(-?[\d.]+)(px|rem|em)$/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  if (match[2] === 'px') return value;
  const of = match[2] === 'rem' ? el.ownerDocument.documentElement : el;
  return value * (parseFloat(view.getComputedStyle(of).fontSize) || 16);
}

/** The data-ds-key of the row that shows `line` in a view. */
function lineKey(line, mode) {
  return mode === 'split' ? `p${line.old ?? ''}:${line.new ?? ''}:ctxctx` : `ctx${line.old ?? ''}:${line.new ?? ''}`;
}

function controller(el, start, outer) {
  const doc = el.ownerDocument;
  // One signal for every listener: the behaviour's, or the view's own destroy().
  const life = new AbortController();
  outer?.addEventListener('abort', () => life.abort(), { once: true });
  const { signal } = life;
  const listeners = { change: new Set(), expand: new Set() };
  const source = start.fromSource ? el.querySelector(':scope > .ds-diff__source') : null;
  let text = start.text ?? source?.textContent ?? '';
  let files = [];
  let destroyed = false;
  /** The view the last render showed, so a resize renders again only when auto turns. */
  let lastMode = null;
  shared.ids += 1;
  const view = {
    id: `ds-diff-${shared.ids}`,
    wanted: VIEWS.has(start.view) ? start.view : 'unified',
    mode: 'unified',
    context: start.context === 'all' ? 'all' : Number.isFinite(start.context) ? Math.max(0, start.context) : 3,
    language: start.language ?? null,
    heading: headingOf(start.heading) ?? 3,
    own: start.highlight,
    highlight: null,
    load: typeof start.load === 'function' ? start.load : null,
    expanded: new Set(),
    folded: new Set(),
    loaded: new Map(),
    loading: new Set(),
  };

  /** New text: its files, nothing opened or loaded yet; a large file starts folded. */
  const reset = () => {
    files = parse(text);
    view.expanded.clear();
    view.loaded.clear();
    view.folded.clear();
    files.forEach((file, index) => {
      if (lineCount(file) > LARGE_FILE) view.folded.add(index);
    });
  };
  reset();

  let holder = el.querySelector(':scope > .ds-diff__files');
  if (!holder) {
    holder = doc.createElement('div');
    holder.className = 'ds-diff__files';
    el.append(holder);
  }

  const modeNow = () => {
    if (view.wanted !== 'auto') return view.wanted;
    const min = lengthOf(el, '--_split-min') ?? 720;
    return el.getBoundingClientRect().width >= min ? 'split' : 'unified';
  };

  const render = () => {
    if (destroyed) return;
    view.mode = modeNow();
    lastMode = view.mode;
    view.highlight = highlighterOf(view.own);
    el.setAttribute('data-view', view.mode);
    const html = files.length
      ? files.map((file, index) => {
        const language = view.language ?? languageOf(file.path);
        return fileHtml(file, index, { ...view, language });
      }).join('')
      : `<p class="ds-diff__empty">${esc(t('diffNoChanges'))}</p>`;
    morphHtml(holder, html);
    if (source && !source.hidden) source.hidden = true;
    watcher?.takeRecords();
  };

  /** One file again (a toggle, a fold, lines loaded): the rest stays as it is, unparsed and unrendered. */
  const renderFile = (index) => {
    if (destroyed) return;
    const section = holder.children[index];
    const file = files[index];
    if (!file || !section?.classList.contains('ds-diff__file') || modeNow() !== view.mode) {
      render();
      return;
    }
    view.highlight = highlighterOf(view.own);
    morphHtml(section, fileInner(file, index, { ...view, language: view.language ?? languageOf(file.path) }));
    watcher?.takeRecords();
  };

  const tell = (type, detail) => {
    if (signal?.aborted) return;
    emit(el, type, detail);
    listeners[type]?.forEach((fn) => fn(detail));
  };

  /** Focuses the first row of what was folded away, once it shows, and says how many lines came. */
  const reveal = (fileIndex, line, count) => {
    const file = holder.querySelectorAll(':scope > .ds-diff__file')[fileIndex];
    const target = file?.querySelector(`.ds-diff__line[data-ds-key="${lineKey(line, view.mode)}"]`);
    if (target) {
      target.tabIndex = -1;
      target.focus();
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true, signal });
    }
    announce(t(count === 1 ? 'diffShownOne' : 'diffShown', { count }));
    tell('expand', { file: files[fileIndex], count });
  };

  const onClick = (/** @type {MouseEvent} */ event) => {
    const button = /** @type {Element} */ (event.target)?.closest?.('button');
    if (!button || !holder.contains(button)) return;
    if (button.classList.contains('ds-diff__toggle')) {
      const index = [...holder.children].indexOf(button.closest('.ds-diff__file'));
      if (view.folded.has(index)) view.folded.delete(index);
      else view.folded.add(index);
      renderFile(index);
      return;
    }
    const fold = button.getAttribute('data-ds-diff-fold');
    if (fold) {
      const [fileIndex, key] = fold.split('|');
      const shown = withLoaded(files[Number(fileIndex)], view, Number(fileIndex));
      const row = rows(shown, { view: 'unified', context: view.context }).find((item) => item.type === 'fold' && item.key === key);
      view.expanded.add(fold);
      renderFile(Number(fileIndex));
      if (row) reveal(Number(fileIndex), row.lines[0], row.count);
      return;
    }
    const gap = button.getAttribute('data-ds-diff-gap');
    if (gap && view.load && !view.loading.has(gap)) {
      const [fileIndex, key] = gap.split('|');
      const file = files[Number(fileIndex)];
      const hunkIndex = Number(key.slice(1));
      const found = rows(withLoaded(file, view, Number(fileIndex)), { view: 'unified', context: 'all' }).find((item) => item.type === 'hunk' && item.index === hunkIndex);
      if (!found?.gap) return;
      view.loading.add(gap);
      renderFile(Number(fileIndex));
      const textBefore = text;
      Promise.resolve()
        .then(() => view.load({ file, path: file.path, from: found.gap.from, to: found.gap.to }))
        .then((lines) => {
          view.loading.delete(gap);
          if (destroyed || text !== textBefore) return;
          const list = Array.isArray(lines) ? lines.map(String).slice(-found.gap.count) : [];
          const old = found.gap.to - list.length + 1;
          if (list.length) {
            view.loaded.set(gap, list);
            // The loaded lines open the hunk's first run of unchanged lines (keyed by its first old line): never folded again.
            view.expanded.add(`${fileIndex}|f${hunkIndex}:o${old}`);
          }
          renderFile(Number(fileIndex));
          if (list.length) reveal(Number(fileIndex), { old, new: old + file.hunks[hunkIndex].newStart - file.hunks[hunkIndex].oldStart }, list.length);
        }, (error) => {
          view.loading.delete(gap);
          render();
          announce(t('actionFailed'));
          globalThis.reportError?.(error);
        });
    }
  };
  el.addEventListener('click', onClick, { signal });

  // A page that re-renders around the view: changed source text renders
  // again, and a morph that took the files out puts them back.
  const ViewObserver = doc.defaultView?.MutationObserver;
  const watcher = ViewObserver ? new ViewObserver(() => {
    if (destroyed) return;
    if (!holder.isConnected || holder.parentNode !== el) el.append(holder);
    if (source && source.textContent !== text && start.fromSource) {
      text = source.textContent;
      reset();
    }
    render();
  }) : null;
  watcher?.observe(el, { childList: true });
  if (source) watcher?.observe(source, { childList: true, characterData: true, subtree: true });

  // auto: split or unified by the width.
  const Sizes = doc.defaultView?.ResizeObserver;
  const sizes = Sizes ? new Sizes(() => {
    if (view.wanted !== 'auto' || destroyed) return;
    const next = modeNow();
    if (next !== lastMode) {
      lastMode = next;
      render();
    }
  }) : null;
  sizes?.observe(el);

  const handle = {
    get() {
      return { text, view: view.wanted, mode: view.mode, files };
    },
    set(value) {
      const next = typeof value === 'string' ? { text: value } : value ?? {};
      let changed = false;
      if (next.text !== undefined && String(next.text) !== text) {
        text = String(next.text);
        reset();
        changed = true;
      }
      if (next.view !== undefined && VIEWS.has(next.view) && next.view !== view.wanted) {
        view.wanted = next.view;
        changed = true;
      }
      if (next.context !== undefined) view.context = next.context === 'all' ? 'all' : Math.max(0, Number(next.context) || 0);
      if (next.language !== undefined) view.language = next.language;
      if (next.highlight !== undefined) view.own = next.highlight;
      if (next.load !== undefined) view.load = typeof next.load === 'function' ? next.load : null;
      render();
      if (changed) tell('change', { view: view.wanted, text });
    },
    /** Opens every fold. */
    expand() {
      let count = 0;
      files.forEach((file, index) => {
        for (const row of rows(withLoaded(file, view, index), { view: 'unified', context: view.context })) {
          if (row.type !== 'fold') continue;
          const key = `${index}|${row.key}`;
          if (view.expanded.has(key)) continue;
          view.expanded.add(key);
          count += row.count;
        }
      });
      render();
      if (count) {
        announce(t(count === 1 ? 'diffShownOne' : 'diffShown', { count }));
        tell('expand', { file: null, count });
      }
    },
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    update() {
      const options = readOptions(el);
      if (options.view && VIEWS.has(options.view)) view.wanted = options.view;
      if (options.context !== undefined && (options.context === 'all' || Number.isFinite(options.context))) view.context = options.context;
      view.language = options.language ?? null;
      if (options.heading) view.heading = options.heading;
      render();
    },
    /** Renders again (a highlighter that arrived later). */
    refresh: render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      shared.views.delete(handle);
      watcher?.disconnect();
      sizes?.disconnect();
      life.abort();
      Object.values(listeners).forEach((set) => set.clear());
      holder.remove();
      if (source) source.hidden = false;
      el.removeAttribute('data-view');
    },
  };
  shared.views.add(handle);
  render();
  return handle;
}

define('diff', {
  attribute: 'data-ds-diff',
  attributes: ['data-ds-diff-view', 'data-ds-diff-context', 'data-ds-diff-lang', 'data-ds-diff-heading'],
  init(el, ctx) {
    return controller(el, { ...readOptions(el), fromSource: true }, ctx.signal);
  },
});

/**
 * A diff view driven from the page; the same controller the attribute path
 * makes. `text` (default the .ds-diff__source inside), `view` (unified,
 * split, auto), `context` (a number or 'all'), `language`, `heading` (2-6),
 * `highlight` (fn(code, language) → markup, or false) and `load`.
 * @param {Element} el
 * @param {object} [options]
 */
export function create(el, options = {}) {
  const attributes = readOptions(el);
  return controller(el, { ...attributes, ...options, fromSource: options.text === undefined }, null);
}

/**
 * Sets the page's syntax highlighter, fn(code, language) returning the
 * markup of one line (null: back to none), and renders every live view
 * again. Returns the one it replaced.
 * @param {((code: string, language: string) => string) | null} fn
 * @returns {((code: string, language: string) => string) | null}
 */
export function highlighter(fn) {
  const before = shared.highlight;
  shared.highlight = typeof fn === 'function' ? fn : null;
  for (const view of shared.views) view.refresh();
  return before;
}
