/**
 * The rules a theme keeps, as data and small functions, shared by
 * tools/check-theme.mjs, the styleguide's theme check and the repository
 * tests (test/tokens.test.js), so the three never disagree:
 *
 *   MOTION_FAMILIES, MOTION   the motion tokens and hooks no theme sets
 *   TEXT_PAIRS                text on a surface: 4.5:1 (WCAG 1.4.3)
 *   CONTROL_PAIRS, ICON_PAIRS checkbox and radio parts, icons and outlines
 *                             that carry meaning: 3:1 (WCAG 1.4.11)
 *   CHART_PAIRS               every chart mark on the grounds it sits on: 3:1
 *   parseColour(), mix(), resolveColour(), contrast()
 *
 * Copied to dist/tools/ by scripts/build.mjs; plain ES2022, no dependency.
 * Colours are read in the forms the system's own files use: #rgb, #rgba,
 * #rrggbb, #rrggbbaa, rgb() and rgba() (comma or space syntax),
 * transparent, black, white and color-mix(in srgb, ...). Anything else
 * resolves to null ("not checked"), never to a guess.
 */

/** The prefixes of the motion tokens and per-element motion hooks (AGENTS.md, "Non-negotiables"). */
export const MOTION_FAMILIES = [
  'dur',
  'ease',
  'distance',
  'loop',
  'stagger',
  'delay',
  'hold',
  'scale',
  'time-scale',
  'motion',
  'enter',
  'leave',
  'clip-from',
  'draw-length',
  'scan',
  'indicator-lag',
  'indicator-dur',
];

/** A declaration of a motion token or hook (`--ds-dur-fast:`): no theme sets one. */
export const MOTION = new RegExp(`--ds-(${MOTION_FAMILIES.join('|')})[\\w-]*\\s*:`);

/** Whether a custom property name is a motion token or hook. */
export const isMotion = (name) => MOTION.test(`${name}:`);

/** Text pairs that pass AA (4.5:1): [text, surface]. */
export const TEXT_PAIRS = [
  ['--ds-text', '--ds-surface'],
  ['--ds-text', '--ds-backdrop'],
  ['--ds-text', '--ds-surface-highest'],
  ['--ds-text-2', '--ds-surface'],
  ['--ds-text-2', '--ds-backdrop'],
  ['--ds-text-2', '--ds-surface-low'],
  ['--ds-text-2', '--ds-surface-high'],
  ['--ds-text-3', '--ds-surface'],
  ['--ds-on-primary', '--ds-primary'],
  ['--ds-link', '--ds-surface'],
  ['--ds-action-ink', '--ds-surface'],
  ['--ds-action-ink', '--ds-backdrop'],
  ['--ds-on-accent', '--ds-accent'],
  // A selected table row (--ds-table-row-selected, default --ds-accent) keeps its text readable.
  ['--ds-text', '--ds-accent'],
  ['--ds-text-2', '--ds-accent'],
  ['--ds-on-error-container', '--ds-error-container'],
  ['--ds-on-success-container', '--ds-success-container'],
  ['--ds-on-warning-container', '--ds-warning-container'],
  ['--ds-text', '--ds-warning-surface'],
  ['--ds-on-inverse', '--ds-inverse'],
  // A text button in a snackbar (the action, Undo).
  ['--ds-inverse-primary', '--ds-inverse'],
  ['--ds-on-error-container', '--ds-surface'],
  // A field label tints with the ring, or takes the error ink: on every surface a field sits on.
  ['--ds-primary', '--ds-surface'],
  ['--ds-primary', '--ds-surface-low'],
  ['--ds-on-error-container', '--ds-surface-low'],
  // A neutral tag (.ds-tag--neutral) and a badge on a tinted host (2.0).
  ['--ds-text', '--ds-surface-high'],
  // The neutral alert's defaults (--ds-alert-bg, --ds-alert-color), and the plain preset on a card.
  ['--ds-text', '--ds-surface-low'],
  // Floating surfaces: dialogs and side sheets (overlay), menus and the combobox list (popover).
  ['--ds-text', '--ds-surface-overlay'],
  ['--ds-text-2', '--ds-surface-overlay'],
  ['--ds-text', '--ds-surface-popover'],
  ['--ds-text-2', '--ds-surface-popover'],
];

/** Checkboxes and radios at 3:1 (WCAG 1.4.11): box, fill, mark, error. */
export const CONTROL_PAIRS = [
  ['--ds-text-2', '--ds-surface'],
  ['--ds-primary', '--ds-surface'],
  ['--ds-error', '--ds-surface'],
  ['--ds-on-primary', '--ds-primary'],
  ['--ds-surface', '--ds-error'],
];

/** Icons and outlines that carry meaning, at 3:1. */
export const ICON_PAIRS = [
  ['--ds-error', '--ds-surface'],
  ['--ds-success', '--ds-surface'],
  ['--ds-warning', '--ds-surface'],
  ['--ds-outline', '--ds-surface'],
  ['--ds-inverse-primary', '--ds-inverse'],
  ['--ds-focus', '--ds-surface'],
  // The lock of a locked switch on its off and on handle (2.0).
  ['--ds-surface-highest', '--ds-outline'],
  ['--ds-primary', '--ds-on-primary'],
];

/** The chart marks (series, neutral, tones) on the surfaces and the track, at 3:1 (WCAG 1.4.11). */
export const CHART_MARKS = ['--ds-chart-1', '--ds-chart-2', '--ds-chart-3', '--ds-chart-4', '--ds-chart-neutral', '--ds-chart-warning', '--ds-chart-error'];
export const CHART_GROUNDS = ['--ds-surface', '--ds-surface-low', '--ds-chart-track'];
export const CHART_PAIRS = CHART_MARKS.flatMap((mark) => CHART_GROUNDS.map((ground) => [mark, ground]));

const NAMED = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1] };

/** A colour as [r, g, b, a] (channels 0-255, alpha 0-1), or null for a form this module does not read. */
export function parseColour(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (NAMED[text]) return [...NAMED[text]];
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    const parts = digits.match(/../g).map((pair) => parseInt(pair, 16));
    return [parts[0], parts[1], parts[2], parts.length === 4 ? parts[3] / 255 : 1];
  }
  const rgb = /^rgba?\(([^()]*)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const channel = (part) => (part.endsWith('%') ? (Number(part.slice(0, -1)) / 100) * 255 : Number(part));
    const alpha = parts.length === 4 ? (parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3])) : 1;
    const colour = [...parts.slice(0, 3).map(channel), alpha];
    return colour.every((n) => Number.isFinite(n)) ? colour : null;
  }
  return null;
}

/**
 * color-mix(in srgb, a p, b q) as CSS Color 5 computes it: missing shares
 * fill up to 100%, shares that sum below 100% scale the alpha, and the
 * channels mix premultiplied by alpha.
 */
export function mix(a, b, p = null, q = null) {
  if (p === null && q === null) [p, q] = [0.5, 0.5];
  else if (p === null) p = 1 - q;
  else if (q === null) q = 1 - p;
  const sum = p + q;
  if (sum <= 0) return null;
  const [wa, wb] = [p / sum, q / sum];
  const alpha = a[3] * wa + b[3] * wb;
  const channels = [0, 1, 2].map((i) => (alpha === 0 ? 0 : (a[i] * a[3] * wa + b[i] * b[3] * wb) / alpha));
  return [...channels, alpha * Math.min(sum, 1)];
}

/** Splits at top-level commas (not inside parentheses). */
export function splitTop(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/**
 * The colour of a value, following var() through `lookup(name)` (the raw
 * value a name holds on the theme element, or undefined) and resolving
 * color-mix(in srgb, ...). null when a part is not a colour this module
 * reads (or a reference is missing or circular).
 */
export function resolveColour(value, lookup, seen = new Set()) {
  const text = String(value ?? '').trim();
  const reference = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(text);
  if (reference) {
    const [, name, fallback] = reference;
    if (seen.has(name)) return null;
    const held = lookup(name);
    if (held !== undefined && held !== null && String(held).trim() !== 'initial') return resolveColour(held, lookup, new Set([...seen, name]));
    return fallback === undefined ? null : resolveColour(fallback, lookup, seen);
  }
  const colorMix = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/i.exec(text);
  if (colorMix) {
    const sides = splitTop(colorMix[1]);
    if (sides.length !== 2) return null;
    const parsed = sides.map((side) => {
      const share = /\s(\d*\.?\d+)%$/.exec(side);
      const colour = share ? side.slice(0, share.index) : side;
      const leading = /^(\d*\.?\d+)%\s+([\s\S]+)$/.exec(colour);
      const percent = share ? Number(share[1]) / 100 : leading ? Number(leading[1]) / 100 : null;
      return { colour: resolveColour(leading ? leading[2] : colour, lookup, seen), percent };
    });
    if (parsed.some((side) => !side.colour)) return null;
    return mix(parsed[0].colour, parsed[1].colour, parsed[0].percent, parsed[1].percent);
  }
  return parseColour(text);
}

/** A colour laid over an opaque one (source-over). */
export function composite(top, bottom) {
  const alpha = top[3];
  return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)).concat(1);
}

/** WCAG 2 relative luminance of an opaque [r, g, b]. */
export function luminance([r, g, b]) {
  const linear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * The contrast ratio of a foreground on a background. A translucent
 * foreground is laid over the background first; a translucent background
 * over `base` (the page behind it, white by default). null when a colour is
 * missing.
 */
export function contrast(fg, bg, base = [255, 255, 255, 1]) {
  if (!fg || !bg) return null;
  const back = bg[3] < 1 ? composite(bg, base) : bg;
  const front = fg[3] < 1 ? composite(fg, back) : fg;
  const [x, y] = [luminance(front), luminance(back)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** A colour as #rrggbb (opaque) or rgba(r, g, b, a), channels rounded: for messages and tests. */
export function formatColour(colour) {
  if (!colour) return 'not a colour';
  const [r, g, b] = colour.slice(0, 3).map((c) => Math.round(c));
  const alpha = Math.round(colour[3] * 1000) / 1000;
  if (alpha === 1) return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${r}, ${g}, ${b}, ${String(alpha).replace(/^0\./, '.')})`;
}

/**
 * Every pair of the four lists checked against `lookup`, as
 * { kind: 'text' | 'control' | 'icon' | 'chart', fg, bg, min, ratio }
 * (ratio null: not checked, a value this module cannot resolve).
 */
export function pairResults(lookup) {
  const lists = [['text', TEXT_PAIRS, 4.5], ['control', CONTROL_PAIRS, 3], ['icon', ICON_PAIRS, 3], ['chart', CHART_PAIRS, 3]];
  return lists.flatMap(([kind, pairs, min]) => pairs.map(([fg, bg]) => {
    const ratio = contrast(resolveColour(`var(${fg})`, lookup), resolveColour(`var(${bg})`, lookup));
    return { kind, fg, bg, min, ratio };
  }));
}
