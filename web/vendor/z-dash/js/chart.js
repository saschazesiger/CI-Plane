/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * DS.chart (3.0): dependency-free SVG charts on the chart roles. One small
 * engine (scales, nice ticks, a time axis in the page's locale, paths,
 * stacking, hit testing) under the charts of the catalogue: line, area and
 * stacked area (time series with gaps), column and bar (grouped, stacked,
 * horizontal, 100%), combo (columns and a line on two axes), sparkline
 * (line, area, bar), donut, pie and ring, gauge and bar gauge.
 *
 *   <figure class="ds-chart" data-ds-chart="line">           a type: the data is the <table> inside
 *     <figcaption>Requests per hour</figcaption>
 *     <table class="ds-table">
 *       <thead><tr><th>Hour</th><th>Requests</th></tr></thead>
 *       <tbody><tr><th><time datetime="2026-11-04T09:00">09:00</time></th><td>42</td></tr> ...</tbody>
 *     </table>
 *   </figure>
 *   <figure class="ds-chart" data-ds-chart='{"type":"column","labels":["Mon","Tue"],"series":[{"name":"Opened","values":[12,9]}]}'>
 *   const chart = DS.chart.create(el, { type: 'area', labels, series, stack: 'normal' });
 *   chart.set({ labels, series });     the lines morph, the bars glide, the figures count
 *
 * The module draws its own parts into the element, each data-ds-keep so a
 * page that re-renders the element with DS.dom.morphHtml keeps them: the
 * tools (the table view toggle), the legend (one button per series that
 * shows or hides it), the frame (the SVG, the centre figure of a donut or
 * gauge, the tooltip) and, for a chart given as JSON, the table. The table
 * is always there for screen readers (visually hidden while the chart
 * shows); the toggle shows it in place of the plot.
 *
 * Keyboard: the frame is one tab stop (role application, described as a
 * chart, so a screen reader in browse mode passes the arrows through). The
 * arrows move along the points (Left and Right along the x axis, Up and
 * Down through the series at that point; a horizontal bar chart's bars and
 * a donut's slices with either), Page Up and Page Down jump a tenth, Home
 * and End go to the ends, Enter emits ds:select, Escape hides the cursor.
 * Each move shows the crosshair and the tooltip and is announced
 * (DS.a11y.announce). The pointer does the same: the crosshair snaps to the
 * nearest x, columns to their category (every series there), a slice is
 * its own target.
 *
 * Large data: a line or area with more than two points per pixel draws
 * the first, lowest, highest and last point of each pixel column (the
 * layout's `drawn`); the table, the tooltip and the keyboard keep every
 * point.
 *
 * Motion (D14, the named exception "chart path morph"): a line or area
 * morphs its path to new data on --ds-ease-value over --ds-dur-glide, from
 * whatever it shows (an interrupted morph continues from the current
 * frame); points match by their x key, so a sliding time window slides.
 * Its clock is an animation without keyframes on the SVG (id
 * 'ds-chart-morph'), so DS.motion.settled(el, { subtree: true, names:
 * ['ds-chart-morph'] }) waits for it and a paused page holds it. Bars
 * are value bars: rects clipped at the registered --ds-share
 * and --ds-chart-from, which glide in CSS on the same curve and time, so a
 * bar and a line land together; the first render fills them from zero
 * (DS.motion.enterAll(bars, 'fill')). A donut, ring or gauge morphs its
 * arcs the same way, and the figures count (DS.motion.countUp).
 *
 * Events (bubbling, on the element): ds:change { spec } after set(),
 * ds:toggle { series, name, visible }, ds:view { view }, ds:point
 * { index, series, key, label } when the cursor moves to another point and
 * ds:select { index, series, key, label } on a click or Enter.
 *
 * ES2022. No Progressive: features (ResizeObserver, Web Animations and
 * canvas text metrics are at the floor; without them the chart draws once
 * at its first size, morphs land at once and labels are estimated).
 */
import { define, emit, t } from './core.js';
import { countUp, enterAll, motionDuration, motionEasing } from './motion.js';
import { own } from './dom.js';
import { iconElement, table as tableGlyph } from './icons.js';
import { computePlacement } from './position.js';
import { announce } from './a11y.js';
import { absolute, bytes, number, percent } from './format.js';

const SVG = 'http://www.w3.org/2000/svg';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** The chart types and how each is laid out. */
const KINDS = Object.freeze({
  line: 'cartesian',
  area: 'cartesian',
  column: 'cartesian',
  bar: 'cartesian',
  combo: 'cartesian',
  sparkline: 'spark',
  donut: 'radial',
  pie: 'radial',
  ring: 'radial',
  gauge: 'gauge',
  bargauge: 'rows',
});

/** Series in a fixed order: four roles, then the neutral (never cycled). */
const SLOTS = 4;

/** The marker shapes of the four series, around (0, 0) at radius 1. */
const MARKERS = [
  (r) => `M${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`,
  (r) => `M${-r * 0.85} ${-r * 0.85}h${r * 1.7}v${r * 1.7}h${-r * 1.7}Z`,
  (r) => `M0 ${-r * 1.1}L${r * 1.05} ${r * 0.8}H${-r * 1.05}Z`,
  (r) => `M0 ${-r * 1.15}L${r * 1.15} 0L0 ${r * 1.15}L${-r * 1.15} 0Z`,
];

/** The hatchings of series 2 to 4, as the module writes them on its SVG (runtime properties). */
const PATTERN_PROPERTIES = ['--ds-chart-pattern-2', '--ds-chart-pattern-3', '--ds-chart-pattern-4'];

/** The tones a series, a zone or a threshold may take. */
const TONES = ['neutral', 'primary', 'info', 'success', 'warning', 'error'];

/** The gauge's sweep: 240 degrees, open at the bottom. */
const GAUGE_START = (-2 / 3) * Math.PI;
const GAUGE_END = (2 / 3) * Math.PI;

const round = (value) => Math.round(value * 100) / 100;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// A loop, not Math.min(...list): a spread of a long series passes the engine's argument limit.
const minOf = (values, start = Infinity) => {
  let out = start;
  for (const value of values) if (value < out) out = value;
  return out;
};
const maxOf = (values, start = -Infinity) => {
  let out = start;
  for (const value of values) if (value > out) out = value;
  return out;
};

/* ── Ticks ──────────────────────────────────────────── */

/** The step of about `count` ticks over [min, max]: 1, 2 or 5 times a power of ten. */
function tickStep(min, max, count) {
  const raw = Math.abs(max - min) / Math.max(1, count);
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  const factor = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
  return factor * power;
}

/** A multiple of `step` without the float noise of the multiplication (0.30000000000000004). */
function onStep(index, step) {
  if (step >= 1) return index * step;
  const inverse = Math.round(1 / step);
  return Math.abs(inverse * step - 1) < 1e-9 ? index / inverse : Number((index * step).toPrecision(12));
}

/**
 * About `count` round values from `min` to `max` (both included when they
 * fall on the step): 0, 20, 40 ...; 0.1, 0.2 ...; reversed when max < min.
 * @param {number} min
 * @param {number} max
 * @param {number} [count]
 * @returns {number[]}
 */
export function ticks(min, max, count = 5) {
  if (!finite(min) || !finite(max)) return [];
  if (min === max) return [min];
  const reverse = max < min;
  const [low, high] = reverse ? [max, min] : [min, max];
  const step = tickStep(low, high, count);
  if (!step) return [low];
  const out = [];
  for (let index = Math.ceil(low / step - 1e-9); index <= Math.floor(high / step + 1e-9); index += 1) out.push(onStep(index, step) || 0);
  return reverse ? out.reverse() : out;
}

/** [min, max] widened to the round step of about `count` ticks. */
function niceDomain(min, max, count) {
  if (min === max) {
    if (min === 0) return [0, 1];
    return min > 0 ? [0, min * 2] : [min * 2, 0];
  }
  let low = min;
  let high = max;
  for (let pass = 0; pass < 2; pass += 1) {
    const step = tickStep(low, high, count);
    if (!step) break;
    low = onStep(Math.floor(low / step + 1e-9), step);
    high = onStep(Math.ceil(high / step - 1e-9), step);
  }
  return [low || 0, high || 0];
}

/** The ticks of a log scale: the powers of ten, with 2 and 5 between them when there are few. */
function logTicks(min, max, count) {
  if (!(min > 0) || !(max > 0)) return [];
  const first = Math.floor(Math.log10(min));
  const last = Math.ceil(Math.log10(max));
  const decades = last - first;
  const out = [];
  const every = Math.max(1, Math.ceil(decades / Math.max(1, count)));
  for (let power = first; power <= last; power += 1) {
    const base = 10 ** power;
    const steps = decades < count / 2 ? [1, 2, 5] : (power - first) % every === 0 ? [1] : [];
    for (const factor of steps) {
      const value = Number((factor * base).toPrecision(12));
      if (value >= min * (1 - 1e-9) && value <= max * (1 + 1e-9)) out.push(value);
    }
  }
  return out;
}

/* ── Time ───────────────────────────────────────────── */

/** The intervals of a time axis: [unit, how many, about how long]. */
const TIME_STEPS = [
  ['second', 1, SECOND], ['second', 5, 5 * SECOND], ['second', 15, 15 * SECOND], ['second', 30, 30 * SECOND],
  ['minute', 1, MINUTE], ['minute', 5, 5 * MINUTE], ['minute', 15, 15 * MINUTE], ['minute', 30, 30 * MINUTE],
  ['hour', 1, HOUR], ['hour', 3, 3 * HOUR], ['hour', 6, 6 * HOUR], ['hour', 12, 12 * HOUR],
  ['day', 1, DAY], ['day', 2, 2 * DAY], ['week', 1, WEEK],
  ['month', 1, MONTH], ['month', 3, 3 * MONTH], ['month', 6, 6 * MONTH], ['year', 1, YEAR],
];

/** The start of the unit around `date` (local time), aligned to every `step` of it. */
function floorTime(date, unit, step) {
  const d = new Date(date);
  switch (unit) {
    case 'second': d.setMilliseconds(0); d.setSeconds(d.getSeconds() - (d.getSeconds() % step)); break;
    case 'minute': d.setSeconds(0, 0); d.setMinutes(d.getMinutes() - (d.getMinutes() % step)); break;
    case 'hour': d.setMinutes(0, 0, 0); d.setHours(d.getHours() - (d.getHours() % step)); break;
    case 'day': d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDate() - 1) % step)); break;
    case 'week': d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); break;
    case 'month': d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() - (d.getMonth() % step)); break;
    default: d.setHours(0, 0, 0, 0); d.setMonth(0, 1); d.setFullYear(d.getFullYear() - (d.getFullYear() % step));
  }
  return d;
}

/** `date` moved on by `step` units (local time: days stay days across a clock change). */
function addTime(date, unit, step) {
  const d = new Date(date);
  switch (unit) {
    case 'second': d.setSeconds(d.getSeconds() + step); break;
    case 'minute': d.setMinutes(d.getMinutes() + step); break;
    case 'hour': d.setHours(d.getHours() + step); break;
    case 'day': d.setDate(d.getDate() + step); break;
    case 'week': d.setDate(d.getDate() + 7 * step); break;
    case 'month': d.setMonth(d.getMonth() + step); break;
    default: d.setFullYear(d.getFullYear() + step);
  }
  return d;
}

/**
 * About `count` ticks of a time axis from `min` to `max` (ms): on whole
 * seconds, minutes, hours, days, Mondays, months or years of local time,
 * the largest interval that still gives `count` or more ticks; years past
 * that on a round step.
 * @param {number} min
 * @param {number} max
 * @param {number} [count]
 * @returns {number[]}
 */
export function timeTicks(min, max, count = 5) {
  if (!finite(min) || !finite(max) || max < min) return [];
  if (min === max) return [min];
  const span = max - min;
  const wanted = Math.max(1, count);
  let choice = TIME_STEPS.find(([, , length]) => span / length <= wanted);
  if (!choice) {
    const years = tickStep(new Date(min).getFullYear(), new Date(max).getFullYear(), wanted) || 1;
    choice = ['year', years, years * YEAR];
  }
  const [unit, step] = choice;
  const out = [];
  let at = floorTime(min, unit, step);
  if (at.getTime() < min) at = addTime(at, unit, step);
  // Steps of several hours, days or months restart at the next unit up (hours at midnight).
  for (let guard = 0; at.getTime() <= max && guard < 1000; guard += 1) {
    out.push(at.getTime());
    at = addTime(at, unit, step);
    if (unit !== 'week' && unit !== 'year') at = floorTime(at, unit, step);
  }
  return out;
}

/** The Intl options of one tick of a time axis: the coarsest unit the tick starts. */
function timeTickFormat(value) {
  const d = new Date(value);
  if (d.getSeconds() || d.getMilliseconds()) return { hour: 'numeric', minute: '2-digit', second: '2-digit' };
  if (d.getMinutes() || d.getHours()) return { hour: 'numeric', minute: '2-digit' };
  if (d.getDate() !== 1) return { month: 'short', day: 'numeric' };
  if (d.getMonth()) return { month: 'short' };
  return { year: 'numeric' };
}

/** The Intl options of a point's x in the tooltip and the table: as fine as the data. */
function timePointFormat(step, span) {
  if (step < DAY) return span > DAY ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit', ...(step < MINUTE ? { second: '2-digit' } : {}) };
  if (step < 28 * DAY) return { year: 'numeric', month: 'short', day: 'numeric' };
  if (step < YEAR) return { year: 'numeric', month: 'short' };
  return { year: 'numeric' };
}

/** The point format of a list of dates (ms): from their smallest step and their span. */
function timesFormat(times) {
  let step = Infinity;
  for (let i = 1; i < times.length; i += 1) if (times[i] > times[i - 1] && times[i] - times[i - 1] < step) step = times[i] - times[i - 1];
  if (!Number.isFinite(step)) step = DAY;
  const span = times.length ? times[times.length - 1] - times[0] : 0;
  return timePointFormat(step, span);
}

/* ── Scales ─────────────────────────────────────────── */

/**
 * A scale from a domain to a range of pixels: 'linear', 'log', 'time' (ms)
 * or 'band' (a list of keys, each a band of `bandwidth`, `padding` between
 * them as a share of the step, default 0.2; `outer` before and after,
 * default half of it). Returns { type, domain, range, map(value), invert(px),
 * ticks(count), bandwidth, step }; map() of a band key gives the band's
 * centre, invert() the index (band) or the value. A value outside the
 * domain maps outside the range; a log scale maps zero and below to NaN.
 * @param {'linear'|'log'|'time'|'band'} type
 * @param {any[]} domain
 * @param {[number, number]} range
 * @param {{ padding?: number, outer?: number }} [options]
 */
export function scale(type, domain, range, options = {}) {
  const [r0, r1] = range;
  if (type === 'band') {
    const keys = [...domain];
    const n = keys.length;
    const padding = options.padding ?? 0.2;
    const outer = options.outer ?? padding / 2;
    const step = (r1 - r0) / Math.max(1, n - padding + 2 * outer);
    const bandwidth = Math.abs(step * (1 - padding));
    const start = r0 + step * outer;
    const index = new Map(keys.map((key, i) => [String(key), i]));
    const at = (i) => start + i * step + (step * (1 - padding)) / 2;
    return {
      type, domain: keys, range: [r0, r1], bandwidth, step,
      map: (value) => {
        const i = typeof value === 'number' && !index.has(String(value)) ? value : index.get(String(value));
        return i === undefined ? NaN : at(i);
      },
      invert: (px) => (n ? clamp(Math.round((px - start - (step * (1 - padding)) / 2) / step), 0, n - 1) : -1),
      ticks: () => keys,
    };
  }
  const [d0, d1] = domain.map(Number);
  const log = type === 'log';
  const f = log ? (value) => (value > 0 ? Math.log10(value) : NaN) : (value) => value;
  const f0 = f(d0);
  const span = f(d1) - f0;
  const map = (value) => (span ? r0 + ((f(Number(value)) - f0) / span) * (r1 - r0) : (r0 + r1) / 2);
  const invert = (px) => {
    const v = f0 + ((px - r0) / (r1 - r0 || 1)) * span;
    return log ? 10 ** v : v;
  };
  const tickList = (count = 5) => (log ? logTicks(Math.min(d0, d1), Math.max(d0, d1), count) : type === 'time' ? timeTicks(Math.min(d0, d1), Math.max(d0, d1), count) : ticks(d0, d1, count));
  return { type, domain: [d0, d1], range: [r0, r1], bandwidth: 0, step: 0, map, invert, ticks: tickList };
}

/* ── Paths ──────────────────────────────────────────── */

/** The tangents of a monotone cubic through the points (Fritsch-Carlson, as d3's curveMonotoneX). */
function monotoneTangents(points) {
  const n = points.length;
  const slopes = [];
  for (let i = 0; i < n - 1; i += 1) {
    const h = points[i + 1].x - points[i].x;
    slopes.push(h ? (points[i + 1].y - points[i].y) / h : 0);
  }
  const tangents = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    const h0 = points[i].x - points[i - 1].x;
    const h1 = points[i + 1].x - points[i].x;
    const s0 = slopes[i - 1];
    const s1 = slopes[i];
    const p = (s0 * h1 + s1 * h0) / ((h0 + h1) || 1);
    tangents[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  if (n > 1) {
    const end = (h, slope, inner) => (h ? (3 * slope - inner) / 2 : inner);
    tangents[0] = n > 2 ? end(points[1].x - points[0].x, slopes[0], tangents[1]) : slopes[0];
    tangents[n - 1] = n > 2 ? end(points[n - 1].x - points[n - 2].x, slopes[n - 2], tangents[n - 2]) : slopes[0];
  }
  return tangents;
}

/** The commands from one point to the next along a run, after the first point's M (or L). */
function runCommands(run, curve) {
  if (run.length < 2) return [];
  const out = [];
  if (curve === 'step') {
    for (let i = 1; i < run.length; i += 1) out.push(`H${round(run[i].x)}`, `V${round(run[i].y)}`);
    return out;
  }
  if (curve === 'monotone' && run.length > 2) {
    const tangent = monotoneTangents(run);
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1];
      const b = run[i];
      const dx = (b.x - a.x) / 3;
      out.push(`C${round(a.x + dx)} ${round(a.y + dx * tangent[i - 1])} ${round(b.x - dx)} ${round(b.y - dx * tangent[i])} ${round(b.x)} ${round(b.y)}`);
    }
    return out;
  }
  for (let i = 1; i < run.length; i += 1) out.push(`L${round(run[i].x)} ${round(run[i].y)}`);
  return out;
}

/** The defined runs of a list of points (a null, or a point without a finite y, breaks a run). */
function runs(points, key = 'y') {
  const out = [];
  let run = [];
  for (const point of points) {
    if (point && finite(point.x) && finite(point[key])) run.push(point);
    else if (run.length) {
      out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * The SVG path data of a line through `points` ({ x, y } in px; null or a
 * point without a finite y is a gap): `curve` 'linear' (default),
 * 'monotone' (a smooth curve that never overshoots a point) or 'step' (each
 * value holds until the next point). With `area: true` each run closes
 * down to its points' `y0` (the baseline, or the series below a stack)
 * along the same curve, so stacked areas share their edges exactly. A
 * lone point between gaps draws nothing as a line (its marker shows it)
 * and a hairline-wide band as an area.
 * @param {Array<{ x: number, y: number, y0?: number }|null>} points
 * @param {{ curve?: 'linear'|'monotone'|'step', area?: boolean }} [options]
 * @returns {string}
 */
export function path(points, options = {}) {
  const curve = options.curve ?? 'linear';
  const parts = [];
  for (const run of runs(points ?? [])) {
    if (!options.area) {
      if (run.length < 2) continue;
      parts.push(`M${round(run[0].x)} ${round(run[0].y)}`, ...runCommands(run, curve));
      continue;
    }
    const top = run.length > 1 ? run : [{ ...run[0], x: run[0].x - 0.5 }, { ...run[0], x: run[0].x + 0.5 }];
    const base = top.map((point) => ({ x: point.x, y: finite(point.y0) ? point.y0 : point.y })).reverse();
    // Step areas step down the baseline the other way round, so they match the series below.
    const back = curve === 'step' ? stepBack(base) : runCommands(base, curve);
    parts.push(`M${round(top[0].x)} ${round(top[0].y)}`, ...runCommands(top, curve), `L${round(base[0].x)} ${round(base[0].y)}`, ...back, 'Z');
  }
  return parts.join('');
}

/**
 * A step baseline walked backwards: each value holds from its point to the
 * next one, so going back the height changes first, then the run goes on.
 */
function stepBack(base) {
  const out = [];
  for (let i = 1; i < base.length; i += 1) out.push(`V${round(base[i].y)}`, `H${round(base[i].x)}`);
  return out;
}

/**
 * An annular sector (a donut slice, a ring, a gauge arc) around (cx, cy):
 * radii `inner` (0: a pie slice) to `outer`, from angle `a0` to `a1` in
 * radians clockwise from twelve o'clock.
 */
function arcPath(cx, cy, inner, outer, a0, a1) {
  const sweep = a1 - a0;
  if (!(sweep > 1e-6) || !(outer > 0)) return '';
  const full = sweep >= 2 * Math.PI - 1e-6;
  const end = full ? a0 + 2 * Math.PI - 1e-4 : a1;
  const large = end - a0 > Math.PI ? 1 : 0;
  const at = (r, a) => `${round(cx + r * Math.sin(a))} ${round(cy - r * Math.cos(a))}`;
  const outerArc = `M${at(outer, a0)}A${round(outer)} ${round(outer)} 0 ${large} 1 ${at(outer, end)}`;
  if (inner <= 0) return `${outerArc}L${round(cx)} ${round(cy)}Z`;
  return `${outerArc}L${at(inner, end)}A${round(inner)} ${round(inner)} 0 ${large} 0 ${at(inner, a0)}Z`;
}

/* ── Stacking ───────────────────────────────────────── */

/**
 * Stacks series (arrays of numbers; null or a missing value counts 0 and
 * stays a gap of its own series): positive values upwards from 0, negative
 * ones downwards, in series order. `offset: 'percent'` scales each index
 * to its share of the sum of the absolute values, so a full stack reaches
 * 1. Returns per series and index `[lo, hi]`, or null for a gap.
 * @param {Array<Array<number|null|undefined>>} series
 * @param {{ offset?: 'normal'|'percent' }} [options]
 * @returns {Array<Array<[number, number]|null>>}
 */
export function stack(series, options = {}) {
  const length = Math.max(0, ...series.map((values) => values?.length ?? 0));
  const out = series.map(() => new Array(length).fill(null));
  for (let i = 0; i < length; i += 1) {
    const values = series.map((values) => (finite(values?.[i]) ? values[i] : null));
    const total = values.reduce((sum, value) => sum + Math.abs(value ?? 0), 0);
    const factor = options.offset === 'percent' ? (total ? 1 / total : 0) : 1;
    let up = 0;
    let down = 0;
    values.forEach((value, s) => {
      if (value === null) {
        // A gap sits on the stack below it, zero thick.
        out[s][i] = null;
        return;
      }
      const v = value * factor;
      if (v >= 0) {
        out[s][i] = [up, up + v];
        up += v;
      } else {
        out[s][i] = [down + v, down];
        down += v;
      }
    });
  }
  return out;
}

/* ── Hit testing ────────────────────────────────────── */

/**
 * The index of the position nearest to `value` in a list sorted either way
 * (a binary search), or -1 for an empty list. Equal distances take the
 * later point.
 * @param {number[]} positions
 * @param {number} value
 * @returns {number}
 */
export function nearest(positions, value) {
  const n = positions?.length ?? 0;
  if (!n || !finite(value)) return -1;
  const ascending = positions[n - 1] >= positions[0];
  let low = 0;
  let high = n - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((positions[mid] < value) === ascending) low = mid;
    else high = mid;
  }
  return Math.abs(positions[low] - value) < Math.abs(positions[high] - value) ? low : high;
}

/** The slice of a donut at an angle (radians from twelve o'clock, clockwise), or -1. */
function sliceAt(slices, angle) {
  const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return slices.findIndex((slice) => slice.visible && a >= slice.a0 && a < slice.a1);
}

/* ── Data ───────────────────────────────────────────── */

/** A number of a cell or a JSON value: null for a blank, a dash or what is no number. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/[\s  ]/g, '');
  if (!text || /^[-–—]$/.test(text)) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A date of an x value (Date, ISO text), or null. */
function toTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'string' && ISO_DATE.test(value.trim())) {
    const text = value.trim();
    // A date alone means local midnight, as people read it.
    const parsed = /^\d{4}-\d{2}(-\d{2})?$/.test(text) ? new Date(`${text.length === 7 ? `${text}-01` : text}T00:00`) : new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  return null;
}

/** A cell's value: data-value, a <time datetime>, else its text. */
function cellValue(cell) {
  const data = cell.getAttribute?.('data-value');
  if (data !== null && data !== undefined) return data;
  const time = cell.querySelector?.('time[datetime]');
  if (time) return time.getAttribute('datetime');
  return (cell.textContent ?? '').trim();
}

/**
 * Reads a <table> into a chart spec: the header row names the x axis and
 * the series, each body row is one point (its first cell the x: a date,
 * a number or a category; `data-value` or a <time datetime> wins over the
 * text), an empty cell or a dash is a gap. A header cell may carry
 * `data-ds-chart-mark` (line, area, column), `data-ds-chart-axis` (end)
 * and `data-ds-chart-tone`.
 * @param {HTMLTableElement} table
 * @returns {{ labels: any[], series: Array<{ name: string, values: Array<number|null>, mark?: string, axis?: string, tone?: string }>, x: { label: string } }}
 */
export function parse(table) {
  const head = table?.tHead?.rows?.[0] ?? table?.rows?.[0];
  const headCells = head ? [...head.cells] : [];
  const bodyRows = table?.tBodies?.length ? [...table.tBodies].flatMap((body) => [...body.rows]) : [...(table?.rows ?? [])].slice(1);
  const series = headCells.slice(1).map((cell) => {
    const entry = { name: (cell.textContent ?? '').trim(), values: [] };
    for (const [attribute, key] of [['data-ds-chart-mark', 'mark'], ['data-ds-chart-axis', 'axis'], ['data-ds-chart-tone', 'tone']]) {
      const value = cell.getAttribute?.(attribute);
      if (value) entry[key] = value;
    }
    return entry;
  });
  const labels = [];
  for (const row of bodyRows) {
    const cells = [...row.cells];
    if (!cells.length) continue;
    labels.push(cellValue(cells[0]));
    series.forEach((entry, index) => entry.values.push(cells[index + 1] ? toNumber(cellValue(cells[index + 1])) : null));
  }
  return { labels, series, x: { label: (headCells[0]?.textContent ?? '').trim() } };
}

/** A tone name, or null. */
const toneOf = (value) => (TONES.includes(value) ? value : null);

/**
 * The spec with its defaults: the kind, the x type, each series' mark,
 * axis, slot and visibility, the value format.
 */
function normalize(input, previous) {
  const spec = { ...(input ?? {}) };
  const type = KINDS[spec.type] ? spec.type : 'line';
  const kind = KINDS[type];
  const rawLabels = Array.isArray(spec.labels) ? spec.labels : [];
  const rawSeries = Array.isArray(spec.series) ? spec.series : finite(spec.value) ? [{ name: spec.name ?? '', values: [spec.value] }] : [];
  const length = Math.max(rawLabels.length, ...rawSeries.map((entry) => (Array.isArray(entry?.values) ? entry.values.length : 0)), 0);
  const labels = Array.from({ length }, (_, i) => rawLabels[i] ?? i + 1);
  const times = labels.map(toTime);
  const xOption = spec.x ?? {};
  const hasColumns = type === 'column' || type === 'bar' || type === 'combo' || (type === 'sparkline' && spec.mark === 'bar');
  let xType = xOption.type;
  if (!['time', 'linear', 'band'].includes(xType)) {
    if (hasColumns) xType = 'band';
    else if (labels.length && times.every((value) => value !== null)) xType = 'time';
    else if (labels.length && labels.every((value) => typeof value === 'number')) xType = 'linear';
    else xType = 'band';
  }
  const dates = labels.length > 0 && times.every((value) => value !== null);
  const xs = xType === 'time' ? times : xType === 'linear' ? labels.map(Number) : labels.map((_, i) => i);
  const keys = labels.map((label, i) => (dates ? String(times[i]) : String(label)));
  const hidden = new Set(previous ? previous.series.filter((entry) => !entry.visible).map((entry) => entry.name) : []);
  const series = rawSeries.map((entry, index) => {
    const values = Array.from({ length }, (_, i) => toNumber(entry?.values?.[i]));
    let mark = ['line', 'area', 'column'].includes(entry?.mark) ? entry.mark : null;
    if (!mark) {
      if (type === 'area') mark = 'area';
      else if (type === 'column' || type === 'bar') mark = 'column';
      else if (type === 'combo') mark = index === rawSeries.length - 1 && rawSeries.length > 1 ? 'line' : 'column';
      else if (type === 'sparkline') mark = spec.mark === 'bar' ? 'column' : spec.mark === 'area' ? 'area' : 'line';
      else mark = 'line';
    }
    const axis = entry?.axis === 'end' || (type === 'combo' && spec.y2 && mark === 'line' && entry?.axis !== 'start') ? 'end' : 'start';
    const name = String(entry?.name ?? '');
    return {
      name, values, mark, axis,
      tone: toneOf(entry?.tone),
      slot: index < SLOTS ? index : -1,
      visible: entry?.visible === false ? false : !hidden.has(name),
    };
  });
  const stackMode = spec.stack === 'percent' || spec.stack === true || spec.stack === 'normal' ? (spec.stack === 'percent' ? 'percent' : 'normal') : null;
  return {
    type, kind,
    horizontal: type === 'bar',
    labels, keys, xs, dates, xType,
    // Once per spec: the tooltip, the table and the band labels format every point with it.
    timeFormat: dates ? timesFormat(times) : null,
    series,
    stack: stackMode,
    curve: ['linear', 'monotone', 'step'].includes(spec.curve) ? spec.curve : 'linear',
    markers: spec.markers ?? 'auto',
    patterns: spec.patterns === true,
    x: { label: xOption.label ?? '', format: xOption.format ?? null },
    // A sparkline shows the shape of its values: its axis leaves out zero unless asked (bars stand on it anyway).
    y: { type: spec.y?.type === 'log' ? 'log' : 'linear', min: toNumber(spec.y?.min), max: toNumber(spec.y?.max), label: spec.y?.label ?? '', zero: spec.y?.zero ?? kind !== 'spark', format: spec.y?.format ?? spec.format ?? null },
    y2: spec.y2 ? { type: spec.y2.type === 'log' ? 'log' : 'linear', min: toNumber(spec.y2.min), max: toNumber(spec.y2.max), label: spec.y2.label ?? '', zero: spec.y2.zero !== false, format: spec.y2.format ?? null } : null,
    format: spec.format ?? null,
    thresholds: (Array.isArray(spec.thresholds) ? spec.thresholds : []).map((entry) => ({
      value: toNumber(entry?.value), from: toNumber(entry?.from), to: toNumber(entry?.to),
      label: String(entry?.label ?? ''), axis: entry?.axis === 'end' ? 'end' : 'start', tone: toneOf(entry?.tone),
    })).filter((entry) => entry.value !== null || (entry.from !== null && entry.to !== null)),
    annotations: (Array.isArray(spec.annotations) ? spec.annotations : []).map((entry) => ({
      at: entry?.at ?? null, from: entry?.from ?? null, to: entry?.to ?? null, label: String(entry?.label ?? ''), tone: toneOf(entry?.tone),
    })),
    min: toNumber(spec.min) ?? 0,
    max: toNumber(spec.max),
    zones: (Array.isArray(spec.zones) ? spec.zones : []).map((zone) => ({ to: toNumber(zone?.to), tone: toneOf(zone?.tone), label: String(zone?.label ?? '') })),
    legend: spec.legend ?? (kind === 'cartesian' || kind === 'radial'),
    table: spec.table !== false && kind !== 'gauge' && kind !== 'rows' && kind !== 'spark',
    tooltip: spec.tooltip !== false && kind !== 'gauge' && kind !== 'rows' && !(kind === 'spark' && spec.tooltip !== true),
    label: spec.label ?? null,
    title: spec.title ?? '',
  };
}

/* ── Formats ────────────────────────────────────────── */

/**
 * A value as text: `format` 'bytes', 'percent' (a share: 0.42 is 42%), an
 * object of Intl.NumberFormat options, or nothing (up to two decimals).
 */
function formatValue(value, format, compact = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  if (format === 'bytes') return bytes(value);
  if (format === 'percent') return percent(value, { maximumFractionDigits: 1 });
  if (format && typeof format === 'object') return number(value, format);
  return compact ? number(value, { notation: 'compact', maximumFractionDigits: 1 }) : number(value, { maximumFractionDigits: 2 });
}

/** The point formats of specs normalized elsewhere (without timeFormat). */
const handFormats = new WeakMap();

/** The label of an x position, as the tooltip and the table write it. */
function formatX(spec, index) {
  const label = spec.labels[index];
  if (spec.dates) {
    // A normalized spec carries its format; one made by hand gets it here, once.
    let format = spec.x.format ?? spec.timeFormat ?? handFormats.get(spec);
    if (!format) {
      format = timesFormat(spec.keys.map(Number));
      handFormats.set(spec, format);
    }
    return absolute(Number(spec.keys[index]), format);
  }
  if (typeof label === 'number') return formatValue(label, spec.x.format);
  return String(label ?? '');
}

/* ── Layout ─────────────────────────────────────────── */

/** A text width estimate where no canvas measures (Node, a test). */
const estimate = (text, size = 12) => String(text).length * size * 0.56;

/** The domain of one value axis: the values it shows, the thresholds on it, zero where bars stand. */
function axisDomain(values, options, needsZero) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!finite(value)) continue;
    if (options.type === 'log' && value <= 0) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min === Infinity) [min, max] = options.type === 'log' ? [1, 10] : [0, 1];
  if (options.type !== 'log' && (needsZero || options.zero)) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (options.min !== null) min = options.min;
  if (options.max !== null) max = options.max;
  return [min, max];
}

/**
 * Where everything of a chart goes in a box of `width` x `height` px: the
 * scales, the plot, the axes and their ticks, the points of each series
 * (x, y, the stack's y0, the value) and those its path draws (`drawn`:
 * all of them, or a reduction where there are more than two a pixel), the
 * bars (their band and their shares of the plot), the slices or rings of
 * a radial chart, the gauge's arcs, the positions the cursor snaps to.
 * Pure (no DOM): `metrics` gives `measure(text)` (default an estimate),
 * `line` (the label line height, 16), `gap` (8), `bar` (the widest bar,
 * 24), `seam` (the gap between touching bars, 2) and `marker` (8).
 * @param {object} spec  the input of create() (or a normalized one)
 * @param {number} width
 * @param {number} height
 * @param {{ measure?: (text: string) => number, line?: number, gap?: number, bar?: number, seam?: number, marker?: number }} [metrics]
 */
export function layout(spec, width, height, metrics = {}) {
  const s = spec?.kind ? spec : normalize(spec);
  const m = {
    measure: metrics.measure ?? ((text) => estimate(text)),
    line: metrics.line ?? 16,
    gap: metrics.gap ?? 8,
    bar: metrics.bar ?? 24,
    seam: metrics.seam ?? 2,
    marker: metrics.marker ?? 8,
  };
  const box = { width: Math.max(0, width), height: Math.max(0, height) };
  if (s.kind === 'radial') return radialLayout(s, box, m);
  if (s.kind === 'gauge') return gaugeLayout(s, box, m);
  if (s.kind === 'rows') return rowsLayout(s);
  return cartesianLayout(s, box, m);
}

/** The stacked or plain [lo, hi] of every visible series, per axis and mark group. */
function seriesRanges(s) {
  const ranges = s.series.map((entry) => entry.values.map((value) => (value === null ? null : entry.mark === 'line' && !s.stack ? [value, value] : [0, value])));
  if (!s.stack) return ranges;
  // Columns stack with columns, lines and areas with each other, per axis.
  const groups = new Map();
  s.series.forEach((entry, index) => {
    if (!entry.visible) return;
    const group = `${entry.axis}:${entry.mark === 'column' ? 'column' : 'area'}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(index);
  });
  for (const members of groups.values()) {
    const stacked = stack(members.map((index) => s.series[index].values), { offset: s.stack === 'percent' ? 'percent' : 'normal' });
    members.forEach((index, i) => { ranges[index] = stacked[i]; });
  }
  return ranges;
}

/** The ticks of a value axis that fit `length` px, with the scale over its nice domain. */
function valueAxis(options, domain, length, from, to, percentScale) {
  const count = Math.max(2, Math.round(length / 56));
  let [low, high] = domain;
  if (options.type === 'log') {
    low = 10 ** Math.floor(Math.log10(low));
    high = 10 ** Math.ceil(Math.log10(high));
    if (low === high) high = low * 10;
  } else if (!(options.min !== null && options.max !== null)) {
    const [niceLow, niceHigh] = niceDomain(low, high, count);
    if (options.min === null) low = niceLow;
    if (options.max === null) high = niceHigh;
  }
  if (percentScale && options.max === null) high = Math.min(high, 1);
  const sc = scale(options.type === 'log' ? 'log' : 'linear', [low, high], [from, to]);
  const values = sc.ticks(count).filter((value) => value >= Math.min(low, high) - 1e-9 && value <= Math.max(low, high) + 1e-9);
  const compact = Math.max(Math.abs(low), Math.abs(high)) >= 10000;
  const format = percentScale ? 'percent' : options.format;
  return { scale: sc, ticks: values.map((value) => ({ value, label: formatValue(value, format, compact && !format) })) };
}

function cartesianLayout(s, box, m) {
  const spark = s.kind === 'spark';
  const visible = s.series.filter((entry) => entry.visible);
  const ranges = seriesRanges(s);
  const n = s.labels.length;
  const percentScale = s.stack === 'percent';
  const axes = ['start', 'end'].map((axis) => {
    const members = s.series.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.visible && entry.axis === axis);
    if (!members.length && (axis === 'end' || visible.length)) return null;
    const options = axis === 'end' ? s.y2 ?? s.y : s.y;
    const values = [];
    for (const { index } of members) for (const range of ranges[index]) if (range) values.push(range[0], range[1]);
    for (const entry of s.thresholds) if (entry.axis === axis) values.push(entry.value, entry.from, entry.to);
    const needsZero = members.some(({ entry }) => entry.mark !== 'line') || percentScale;
    return { axis, options, members, domain: axisDomain(values, options, needsZero), needsZero };
  });
  const [startAxis, endAxis] = axes;
  const line = m.line;
  const hasTitles = !spark && Boolean(s.y.label || (endAxis && s.y2?.label));
  // A labelled line across the categories (a threshold of a bar chart, an annotation of the others) says its word above the plot.
  const crossLabels = !spark && (s.horizontal ? s.thresholds.some((entry) => entry.label && entry.value !== null) : s.annotations.some((entry) => entry.label && entry.at !== null));
  const top = spark ? m.marker / 2 + 1 : line / 2 + (hasTitles || crossLabels ? line + m.gap / 2 : 0);
  const bottom = spark ? m.marker / 2 + 1 : line + m.gap;

  // Category labels of a horizontal bar chart sit at the start; their width sets the margin.
  const labelText = s.labels.map((_, i) => (s.xType === 'band' ? formatX(s, i) : ''));
  let start = spark ? m.marker / 2 + 1 : 0;
  let end = spark ? m.marker / 2 + 1 : m.gap;
  const plotTop = top;
  const plotBottom = box.height - bottom;
  const plotHeight = Math.max(1, plotBottom - plotTop);
  let valueStart = null;
  let valueEnd = null;

  // Measured once: a long category axis has a label per point.
  const widestLabel = s.xType === 'band' && !spark ? maxOf(labelText.map((text) => m.measure(text)), 0) : 0;
  if (s.horizontal) {
    start = spark ? start : Math.min(box.width * 0.4, widestLabel) + m.gap;
  } else if (!spark) {
    valueStart = startAxis ? valueAxis(startAxis.options, startAxis.domain, plotHeight, plotBottom, plotTop, percentScale && startAxis.needsZero) : null;
    valueEnd = endAxis ? valueAxis(endAxis.options, endAxis.domain, plotHeight, plotBottom, plotTop, false) : null;
    start = valueStart ? Math.max(...valueStart.ticks.map((tick) => m.measure(tick.label)), 0) + m.gap : m.gap;
    if (valueEnd) end = Math.max(...valueEnd.ticks.map((tick) => m.measure(tick.label)), 0) + m.gap;
  }
  const plot = { x: start, y: plotTop, width: Math.max(1, box.width - start - end), height: plotHeight };
  const plotRight = plot.x + plot.width;

  // The value scales of a horizontal chart run along the width, now that it is known.
  if (s.horizontal) {
    valueStart = startAxis ? valueAxis(startAxis.options, startAxis.domain, plot.width, plot.x, plotRight, percentScale) : null;
    if (spark && valueStart) valueStart = { scale: scale('linear', valueStart.scale.domain, [plot.x, plotRight]), ticks: [] };
  }
  if (spark && !s.horizontal) {
    const domain = startAxis ? startAxis.domain : [0, 1];
    valueStart = { scale: scale(s.y.type === 'log' ? 'log' : 'linear', domain[0] === domain[1] ? [domain[0] - 1, domain[1] + 1] : domain, [plotBottom, plotTop]), ticks: [] };
  }

  // The category or time axis.
  const along = s.horizontal ? [plot.y, plotBottom] : [plot.x, plotRight];
  const length = Math.abs(along[1] - along[0]);
  let xScale;
  if (s.xType === 'band') {
    const lineOnly = s.series.every((entry) => entry.mark !== 'column');
    xScale = scale('band', s.keys, along, lineOnly ? { padding: 0, outer: 0.5 } : { padding: spark ? 0.25 : 0.3 });
  } else {
    const defined = s.xs.filter(finite);
    const lo = defined.length ? minOf(defined) : 0;
    const hi = defined.length ? maxOf(defined) : 1;
    xScale = scale(s.xType === 'time' ? 'time' : 'linear', lo === hi ? [lo - 1, hi + 1] : [lo, hi], along);
  }
  const positions = s.labels.map((_, i) => (s.xType === 'band' ? xScale.map(i) : xScale.map(s.xs[i])));

  // Ticks along the category axis: every label that fits, else every k-th.
  let xTicks = [];
  if (!spark) {
    if (s.xType === 'band') {
      const room = s.horizontal ? line + 4 : Math.max(widestLabel, 1) + m.gap * 2;
      const every = Math.max(1, Math.ceil((n * room) / Math.max(1, length)));
      xTicks = labelText.map((label, i) => ({ value: i, pos: positions[i], label })).filter((_, i) => (n - 1 - i) % every === 0);
    } else {
      const count = Math.max(2, Math.floor(length / (s.xType === 'time' ? 96 : 72)));
      const values = xScale.ticks(count);
      const compact = Math.max(...values.map(Math.abs), 0) >= 10000;
      xTicks = values.map((value) => ({
        value,
        pos: xScale.map(value),
        label: s.xType === 'time' ? absolute(value, timeTickFormat(value)) : formatValue(value, s.x.format, compact),
      }));
      // A label that would leave the box moves in; one that would cover its neighbour goes.
      xTicks = xTicks.filter((tick, i, all) => {
        const half = m.measure(tick.label) / 2;
        const prev = all[i - 1];
        return !prev || tick.pos - half > prev.pos + m.measure(prev.label) / 2 + m.gap;
      });
    }
  }

  // Marks.
  const valueScale = (entry) => (entry.axis === 'end' && valueEnd ? valueEnd.scale : valueStart?.scale);
  const columns = s.series.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.mark === 'column');
  const groups = s.stack ? [...new Set(columns.map(({ entry }) => entry.axis))].length : columns.length;
  const band = xScale.bandwidth || 0;
  const thickness = groups ? Math.max(1, Math.min(m.bar, (band - (groups - 1) * m.seam) / groups)) : 0;
  const groupWidth = groups ? groups * thickness + (groups - 1) * m.seam : 0;
  const series = s.series.map((entry, index) => {
    const sc = valueScale(entry);
    const range = ranges[index];
    const base = sc ? sc.map(sc.type === 'log' ? sc.domain[0] : clamp(0, Math.min(...sc.domain), Math.max(...sc.domain))) : 0;
    const points = s.labels.map((_, i) => {
      const r = range[i];
      if (!r || !sc || !entry.visible) return { key: s.keys[i], x: positions[i], y: null, y0: null, value: entry.values[i] };
      const y = sc.map(r[1]);
      const y0 = entry.mark === 'line' && !s.stack ? base : sc.map(r[0]);
      return s.horizontal
        ? { key: s.keys[i], x: y, y: positions[i], y0, value: entry.values[i] }
        : { key: s.keys[i], x: positions[i], y, y0, value: entry.values[i] };
    });
    let bars = [];
    if (entry.mark === 'column' && sc) {
      const slot = s.stack ? [...new Set(columns.map(({ entry: e }) => e.axis))].indexOf(entry.axis) : columns.findIndex(({ index: i }) => i === index);
      const offset = -groupWidth / 2 + slot * (thickness + m.seam);
      const [p0, p1] = s.horizontal ? [plot.x, plotRight] : [plotBottom, plot.y];
      const share = (value) => clamp((sc.map(value) - p0) / (p1 - p0 || 1), 0, 1);
      bars = s.labels.map((_, i) => {
        const r = range[i];
        const at = positions[i] + offset;
        const valueNow = entry.values[i];
        const zeroShare = share(sc.type === 'log' ? sc.domain[0] : clamp(0, Math.min(...sc.domain), Math.max(...sc.domain)));
        const lo = !r || !entry.visible ? zeroShare : share(r[0]);
        const hi = !r || !entry.visible ? zeroShare : share(r[1]);
        const down = finite(valueNow) && valueNow < 0;
        return {
          key: s.keys[i], index: i, value: valueNow,
          x: s.horizontal ? plot.x : at, y: s.horizontal ? at : plot.y,
          width: s.horizontal ? plot.width : thickness, height: s.horizontal ? thickness : plot.height,
          from: Math.min(lo, hi), share: Math.max(lo, hi), down,
          // A segment that sits on another in a stack leaves the seam; only the outer end rounds.
          inner: false, onStack: false,
        };
      });
      if (s.stack) {
        // Mark the outermost segment of each stack (it rounds) and those resting on another.
        bars.forEach((bar) => { bar.onStack = range[bar.index] ? (bar.down ? range[bar.index][1] !== 0 : range[bar.index][0] !== 0) : false; });
      }
    }
    return { ...entry, index, points, bars };
  });
  if (s.stack) {
    // The outer end of each stack rounds; segments below it stay square.
    for (let i = 0; i < n; i += 1) {
      for (const sign of [1, -1]) {
        const members = series.filter((entry) => entry.mark === 'column' && entry.visible && entry.bars[i] && finite(entry.values[i]) && Math.sign(entry.values[i] || 0) === sign && entry.values[i] !== 0);
        members.forEach((entry, k) => { entry.bars[i].inner = k < members.length - 1; });
      }
    }
  }

  // More than two points a pixel: each path draws a reduction (a stack the
  // same indices in every series, so its edges stay shared); the cursor,
  // the tooltip and the table keep every point.
  for (const entry of series) entry.drawn = entry.points;
  if (n > 2 * Math.max(1, length)) {
    const along = s.horizontal ? 'y' : 'x';
    const paths = series.filter((entry) => entry.mark !== 'column');
    const shown = paths.filter((entry) => entry.visible);
    for (const entry of paths) if (!entry.visible) entry.drawn = [];
    const pick = (entry, indices) => { entry.drawn = [...indices].sort((a, b) => a - b).map((i) => entry.points[i]); };
    if (s.stack) {
      const keep = new Set();
      for (const entry of shown) reduceIndices(entry.points, along, keep);
      for (const entry of shown) pick(entry, keep);
    } else for (const entry of shown) pick(entry, reduceIndices(entry.points, along, new Set()));
  }

  // Thresholds and annotations.
  const rules = s.thresholds.map((entry) => {
    const sc = entry.axis === 'end' && valueEnd ? valueEnd.scale : valueStart?.scale;
    if (!sc) return null;
    if (entry.value !== null) {
      const at = sc.map(entry.value);
      return { kind: 'line', axis: 'value', at, label: entry.label, tone: entry.tone };
    }
    const a = sc.map(entry.from);
    const b = sc.map(entry.to);
    return { kind: 'band', axis: 'value', from: Math.min(a, b), to: Math.max(a, b), label: entry.label, tone: entry.tone };
  }).filter(Boolean);
  const xOf = (value) => {
    if (s.xType === 'band') {
      const key = s.dates ? String(toTime(value) ?? value) : String(value);
      const i = s.keys.indexOf(key);
      return i < 0 ? NaN : positions[i];
    }
    const v = s.xType === 'time' ? toTime(value) ?? Number(value) : Number(value);
    return xScale.map(v);
  };
  for (const entry of s.annotations) {
    if (entry.at !== null) {
      const at = xOf(entry.at);
      if (finite(at)) rules.push({ kind: 'line', axis: 'x', at, label: entry.label, tone: entry.tone });
    } else if (entry.from !== null && entry.to !== null) {
      let a = xOf(entry.from);
      let b = xOf(entry.to);
      if (s.xType === 'band') {
        a -= xScale.step / 2;
        b += xScale.step / 2;
      }
      if (finite(a) && finite(b)) rules.push({ kind: 'band', axis: 'x', from: Math.min(a, b), to: Math.max(a, b), label: entry.label, tone: entry.tone });
    }
  }

  const markers = s.markers === true || (s.markers === 'auto' && !spark && n > 0 && length / n >= 24);
  return {
    kind: s.kind, box, plot, horizontal: s.horizontal, spark,
    x: xScale, y: valueStart?.scale ?? null, y2: valueEnd?.scale ?? null,
    xTicks, yTicks: valueStart?.ticks ?? [], y2Ticks: valueEnd?.ticks ?? [],
    titles: hasTitles ? { start: s.y.label, end: endAxis ? s.y2?.label ?? '' : '' } : null,
    baseline: valueStart ? valueStart.scale.map(valueStart.scale.type === 'log' ? valueStart.scale.domain[0] : clamp(0, Math.min(...valueStart.scale.domain), Math.max(...valueStart.scale.domain))) : null,
    positions, series, rules, markers, band: xScale.step || 0,
  };
}

/**
 * The indices of the points a path draws when there are more than two a
 * pixel, added to `into`: per pixel column along the axis, the first,
 * lowest, highest and last point of each defined run, so every peak
 * stays; and the first point of each gap, so the path keeps its breaks.
 */
function reduceIndices(points, along, into) {
  const across = along === 'x' ? 'y' : 'x';
  let bucket = NaN;
  let first = -1;
  let low = -1;
  let high = -1;
  let last = -1;
  let gap = false;
  const flush = () => {
    if (first >= 0) into.add(first).add(low).add(high).add(last);
    first = -1;
  };
  points.forEach((point, i) => {
    if (!point || !finite(point[along]) || !finite(point[across])) {
      flush();
      if (!gap) into.add(i);
      gap = true;
      bucket = NaN;
      return;
    }
    gap = false;
    const column = Math.floor(point[along]);
    if (column !== bucket) {
      flush();
      bucket = column;
      first = i;
      low = i;
      high = i;
    }
    if (point[across] < points[low][across]) low = i;
    if (point[across] > points[high][across]) high = i;
    last = i;
  });
  flush();
  return into;
}

function radialLayout(s, box, m) {
  const size = Math.max(0, Math.min(box.width, box.height));
  const cx = box.width / 2;
  const cy = box.height / 2;
  const outer = size / 2 - 1;
  if (s.type === 'ring') {
    // One ring per series, its first value against its max (or the spec's).
    const rings = s.series.slice(0, SLOTS);
    const thickness = Math.max(4, Math.min(16, (outer * 0.55) / Math.max(1, rings.length) - m.seam));
    const items = rings.map((entry, i) => {
      const value = entry.values.find(finite) ?? 0;
      const max = s.max ?? 100;
      const share = clamp((value - s.min) / ((max - s.min) || 1), 0, 1);
      const r1 = outer - i * (thickness + m.seam * 2);
      return { key: entry.name, name: entry.name, value, max, share, slot: entry.slot, tone: entry.tone, visible: entry.visible, inner: r1 - thickness, outer: r1, a0: 0, a1: entry.visible ? share * 2 * Math.PI : 0, index: i };
    });
    return { kind: 'radial', type: 'ring', box, cx, cy, outer, inner: outer - rings.length * (thickness + m.seam * 2), slices: items, total: null, positions: items.map((_, i) => i) };
  }
  const source = s.series[0];
  let slices = (source ? source.values : []).map((value, i) => ({ key: s.keys[i], name: formatX(s, i), value: Math.max(0, value ?? 0), slot: i < SLOTS ? i : -1, index: i, tone: null }));
  if (slices.length > SLOTS + 1) {
    const rest = slices.slice(SLOTS);
    slices = [...slices.slice(0, SLOTS), { key: '\u0000other', name: t('chartOther'), value: rest.reduce((sum, slice) => sum + slice.value, 0), slot: -1, index: SLOTS, tone: null, other: rest.map((slice) => slice.index) }];
  }
  const hiddenKeys = new Set((s.hiddenSlices ?? []));
  slices.forEach((slice) => { slice.visible = !hiddenKeys.has(slice.key); });
  const total = slices.reduce((sum, slice) => sum + (slice.visible ? slice.value : 0), 0);
  const inner = s.type === 'pie' ? 0 : outer * 0.62;
  const pad = slices.filter((slice) => slice.visible && slice.value > 0).length > 1 ? m.seam / Math.max(1, outer) : 0;
  let angle = 0;
  for (const slice of slices) {
    const sweep = total && slice.visible ? (slice.value / total) * 2 * Math.PI : 0;
    slice.a0 = angle;
    slice.a1 = angle + sweep;
    slice.pad = sweep > pad * 2 ? pad / 2 : 0;
    slice.share = total && slice.visible ? slice.value / total : 0;
    slice.outer = outer;
    slice.inner = inner;
    angle += sweep;
  }
  return { kind: 'radial', type: s.type, box, cx, cy, outer, inner, slices, total, positions: slices.map((_, i) => i) };
}

function gaugeLayout(s, box, m) {
  const max = s.max ?? 100;
  const min = s.min ?? 0;
  const value = s.series[0]?.values.find(finite) ?? null;
  // A 240-degree arc fits a box 2r wide and r + r*cos(60) = 1.5r high,
  // with the zones' band outside it and the end labels under it.
  const reach = s.zones.length ? Math.max(2, m.seam * 2) * 2 : 0;
  const room = Math.max(0, box.height - m.line - 6);
  const whole = Math.max(0, Math.min(box.width / 2, room / 1.5) - 1);
  const outer = Math.max(0, whole - reach);
  const thickness = Math.max(6, Math.min(20, outer * 0.16));
  const cx = box.width / 2;
  const cy = whole + 1 + Math.max(0, (room - whole * 1.5) / 2);
  const angleOf = (v) => GAUGE_START + clamp((v - min) / ((max - min) || 1), 0, 1) * (GAUGE_END - GAUGE_START);
  let from = min;
  const zones = s.zones.map((zone, i) => {
    const to = zone.to ?? max;
    const out = { from, to, tone: zone.tone, label: zone.label, a0: angleOf(from), a1: angleOf(to), index: i };
    from = to;
    return out;
  });
  const zone = value === null ? null : zones.find((entry) => value <= entry.to) ?? zones[zones.length - 1] ?? null;
  return {
    kind: 'gauge', box, cx, cy, outer, inner: outer - thickness, thickness, min, max, value,
    a0: GAUGE_START, a1: GAUGE_END, angle: value === null ? GAUGE_START : angleOf(value),
    zones, zone, band: Math.max(2, m.seam * 2),
    ends: [GAUGE_START, GAUGE_END].map((a, i) => ({ x: cx + (outer - thickness / 2) * Math.sin(a), y: cy - (outer + reach) * Math.cos(a) + 4, label: formatValue(i ? max : min, s.format) })),
  };
}

function rowsLayout(s) {
  const source = s.series[0];
  const values = source ? source.values : [];
  const max = s.max ?? maxOf(values.filter(finite), 0);
  const rows = values.map((value, i) => {
    const zone = finite(value) ? s.zones.find((entry) => entry.to === null || value <= entry.to) ?? null : null;
    return {
      key: s.keys[i], label: formatX(s, i), value, text: formatValue(value, s.format),
      share: finite(value) ? clamp((value - s.min) / ((max - s.min) || 1), 0, 1) : 0,
      tone: zone?.tone ?? source?.tone ?? null, status: zone?.label ?? '',
    };
  });
  return { kind: 'rows', rows, max };
}

/* ── Rendering helpers ──────────────────────────────── */

let uid = 0;

const svg = (doc, name, attrs = {}, cls = '') => {
  const el = doc.createElementNS(SVG, name);
  if (cls) el.setAttribute('class', cls);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  return el;
};

const html = (doc, name, cls = '', text = null) => {
  const el = doc.createElement(name);
  if (cls) el.className = cls;
  if (text !== null) el.textContent = text;
  return el;
};

/** Sets attributes on an element only where they changed. */
function attrs(el, values) {
  for (const [key, value] of Object.entries(values)) {
    const text = value === null || value === undefined ? null : String(value);
    if (text === null) el.removeAttribute(key);
    else if (el.getAttribute(key) !== text) el.setAttribute(key, text);
  }
  return el;
}

/** The class of a series: its slot (s2 ... s4, or the neutral) and its tone. */
function seriesClass(base, entry) {
  const slot = entry.slot < 0 ? 'ds-chart__series--other' : entry.slot > 0 ? `ds-chart__series--s${entry.slot + 1}` : '';
  return [...new Set([base, 'ds-chart__series', slot, entry.tone ? `ds-tone-${entry.tone}` : ''])].filter(Boolean).join(' ');
}

/** A keyed child list: the element of each key, made once, in order, the rest removed. */
function keyed(parent, items, keyOf, make) {
  const existing = new Map();
  for (const child of [...parent.children]) existing.set(child.getAttribute('data-key'), child);
  const seen = new Set();
  let before = parent.firstChild;
  const out = items.map((item, i) => {
    const key = String(keyOf(item, i));
    seen.add(key);
    let el = existing.get(key);
    const fresh = !el;
    if (!el) {
      el = make(item, i);
      el.setAttribute('data-key', key);
    }
    if (el !== before) parent.insertBefore(el, before);
    before = el.nextSibling;
    return { el, item, fresh };
  });
  for (const [key, child] of existing) if (!seen.has(key)) child.remove();
  return out;
}

/** The text metrics of a chart: a canvas that measures in the font of its labels. */
const canvases = new WeakMap();

function measurer(el) {
  const doc = el.ownerDocument;
  const view = doc?.defaultView;
  const style = view?.getComputedStyle?.(el);
  const size = parseFloat(style?.fontSize ?? '') || 12;
  let canvas = canvases.get(doc);
  if (!canvas && doc?.createElement) {
    const context = doc.createElement('canvas').getContext?.('2d') ?? null;
    canvas = { context };
    canvases.set(doc, canvas);
  }
  const context = canvas?.context;
  if (context && style) {
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // Tabular figures are a little wider than the canvas's proportional ones.
    return (text) => context.measureText(String(text)).width * 1.04;
  }
  return (text) => estimate(text, size);
}

/** A length of the chart's computed style, in px. */
function lengthOf(style, name, fallback) {
  const value = parseFloat(style?.getPropertyValue(name) ?? '');
  return Number.isFinite(value) ? value : fallback;
}

/* ── The morph clock ────────────────────────────────── */

/** Interpolates two point lists by key (see the header); returns the frame at progress p. */
function blendPoints(from, to, p) {
  return to.map((point) => {
    const start = from.get(point.key);
    if (!start || !finite(point.y) || !finite(start.y)) return point;
    return {
      ...point,
      x: start.x + (point.x - start.x) * p,
      y: start.y + (point.y - start.y) * p,
      y0: finite(point.y0) && finite(start.y0) ? start.y0 + (point.y0 - start.y0) * p : point.y0,
    };
  });
}

/** The points drawn so far, defined, in order along the axis (once per series and morph). */
function alongAxis(shown, horizontal) {
  const along = horizontal ? 'y' : 'x';
  return [...(shown?.values() ?? [])].filter((entry) => finite(entry.x) && finite(entry.y)).sort((a, b) => a[along] - b[along]);
}

/** Where a point that is new comes from: on the line drawn so far (`sorted`, alongAxis()), at its x (or the nearest end). */
function entryPoint(sorted, point, horizontal, baseline) {
  const along = horizontal ? 'y' : 'x';
  const across = horizontal ? 'x' : 'y';
  if (!sorted.length) {
    // The first render: up from the baseline.
    const flat = finite(baseline) ? baseline : point[across];
    return { ...point, [across]: flat, y0: finite(point.y0) ? flat : point.y0 };
  }
  const at = point[along];
  let value;
  let base;
  if (at <= sorted[0][along]) [value, base] = [sorted[0][across], sorted[0].y0];
  else if (at >= sorted[sorted.length - 1][along]) [value, base] = [sorted[sorted.length - 1][across], sorted[sorted.length - 1].y0];
  else {
    // The first drawn point at or after `at` (a binary search: a stream adds points to long lines).
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid][along] >= at) hi = mid;
      else lo = mid + 1;
    }
    const a = sorted[lo - 1];
    const b = sorted[lo];
    const k = (at - a[along]) / ((b[along] - a[along]) || 1);
    value = a[across] + (b[across] - a[across]) * k;
    base = finite(a.y0) && finite(b.y0) ? a.y0 + (b.y0 - a.y0) * k : point.y0;
  }
  return { ...point, [across]: value, y0: finite(point.y0) ? base : point.y0 };
}

/* ── The controller ─────────────────────────────────── */

/** Reads the spec of an element: JSON in data-ds-chart, else its type there and the data of its table. */
function specOf(el) {
  const raw = (el.getAttribute('data-ds-chart') ?? '').trim();
  let spec = {};
  if (raw.startsWith('{')) {
    try {
      spec = JSON.parse(raw);
    } catch {
      spec = {};
    }
  } else if (raw) {
    spec = { type: raw };
  }
  const config = el.getAttribute('data-ds-config');
  if (config) {
    try {
      spec = { ...JSON.parse(config), ...spec };
    } catch {
      /* a broken config counts as none */
    }
  }
  const table = sourceTable(el);
  if (table && !Array.isArray(spec.series)) spec = { ...parse(table), ...spec, x: { ...parse(table).x, ...(spec.x ?? {}) } };
  return spec;
}

/** The page's own table of an element (not the one the module wrote). */
function sourceTable(el) {
  return [...el.children].find((child) => child.tagName === 'TABLE') ?? [...el.children].find((child) => !child.hasAttribute('data-ds-keep') && child.querySelector?.(':scope > table'))?.querySelector(':scope > table') ?? null;
}

const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Escape']);

function controller(el, initial, signal) {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const id = `ds-chart-${(uid += 1)}`;
  const listeners = new Map();
  let spec = normalize(initial);
  let input = { ...(initial ?? {}) };
  let current = null;
  let shown = new Map();       // series index -> Map(key -> point) as drawn now
  let arcsShown = new Map();   // slice key -> { a0, a1 }
  let morph = null;
  let size = { width: 0, height: 0 };
  let cursor = { index: -1, series: -1, active: false };
  // What the cursor marks (the series it picked, the slice it is on): every
  // draw writes it into the class it sets, so a morph frame, set() or a
  // resize keeps it.
  let marks = { series: -1, slice: -1 };
  let viewMode = 'chart';
  let first = true;
  let destroyed = false;
  let hiddenSlices = new Set();

  if (!el.classList.contains('ds-chart')) {
    own(el, 'classes', 'ds-chart');
    el.classList.add('ds-chart');
  }
  own(el, 'attrs', 'data-state');
  el.setAttribute('data-state', 'chart');
  // The modifiers the spec gives: its type, a stack, the patterns.
  const typeClasses = () => [`ds-chart--${spec.type}`, spec.stack ? 'ds-chart--stacked' : '', spec.patterns ? 'ds-chart--patterns' : '', isEmpty() ? 'ds-chart--empty' : ''].filter(Boolean);
  /** No value to draw at all: the frame says so instead of drawing empty axes. */
  const isEmpty = () => !spec.series.some((entry) => entry.values.some(finite));
  let applied = [];

  const keep = (node) => {
    node.setAttribute('data-ds-keep', '');
    return node;
  };

  /** The class of a series part as drawn: its series, then the cursor's marks. */
  const partClass = (entry, extra = '', position = -1) => [
    seriesClass('ds-chart__series', entry),
    extra,
    marks.series >= 0 && entry.index !== marks.series ? 'ds-chart__series--dim' : '',
    marks.slice >= 0 && position === marks.slice ? 'ds-chart__slice--active' : '',
  ].filter(Boolean).join(' ');

  /* Parts. */
  const tools = keep(html(doc, 'div', 'ds-chart__tools'));
  const toggle = html(doc, 'button', 'ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-chart__view');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.append(iconElement(tableGlyph, 20));
  tools.append(toggle);
  const legend = keep(html(doc, 'ul', 'ds-chart__legend'));
  const frame = keep(html(doc, 'div', 'ds-chart__frame'));
  const hint = html(doc, 'span', 'ds-chart__hint');
  hint.id = `${id}-hint`;
  const root = svg(doc, 'svg', { 'aria-hidden': 'true', focusable: 'false' }, 'ds-chart__svg');
  const defs = svg(doc, 'defs');
  const clip = svg(doc, 'clipPath', { id: `${id}-clip` });
  const clipRect = svg(doc, 'rect');
  clip.append(clipRect);
  defs.append(clip);
  for (let slot = 1; slot < SLOTS; slot += 1) {
    const pattern = svg(doc, 'pattern', { id: `${id}-p${slot + 1}`, patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: `rotate(${[0, 45, 135, 0][slot]})` }, `ds-chart__pattern ds-chart__series ds-chart__series--s${slot + 1}`);
    pattern.append(svg(doc, 'rect', { width: 6, height: 6 }, 'ds-chart__pattern-ground'), svg(doc, 'rect', { width: 2.5, height: 6 }, 'ds-chart__pattern-ink'));
    defs.append(pattern);
    root.style.setProperty(PATTERN_PROPERTIES[slot - 1], `url(#${id}-p${slot + 1})`);
  }
  const layer = (cls, clipped = false) => {
    const g = svg(doc, 'g', clipped ? { 'clip-path': `url(#${id}-clip)` } : {}, cls);
    root.append(g);
    return g;
  };
  root.append(defs);
  const gGrid = layer('ds-chart__grid');
  const gBands = layer('ds-chart__bands', true);
  const gHover = layer('ds-chart__hover', true);
  const hoverRect = svg(doc, 'rect', {}, 'ds-chart__band');
  gHover.append(hoverRect);
  const gBars = layer('ds-chart__bars');
  const gAreas = layer('ds-chart__areas', true);
  const gLines = layer('ds-chart__lines', true);
  const gRules = layer('ds-chart__rules');
  const gAxes = layer('ds-chart__axes');
  const cursorLine = svg(doc, 'line', {}, 'ds-chart__cursor');
  root.append(cursorLine);
  const gMarkers = layer('ds-chart__markers');
  const gDots = layer('ds-chart__dots');
  const centre = html(doc, 'div', 'ds-chart__centre');
  const centreValue = html(doc, 'span', 'ds-chart__figure');
  const centreLabel = html(doc, 'span', 'ds-chart__caption');
  centre.append(centreValue, centreLabel);
  // Lengths the stylesheet computes from the options, read back resolved.
  const probe = html(doc, 'span', 'ds-chart__probe');
  probe.setAttribute('aria-hidden', 'true');
  const emptyNote = html(doc, 'span', 'ds-chart__empty');
  const tip = html(doc, 'div', 'ds-chart__tip');
  tip.setAttribute('aria-hidden', 'true');
  const rowsBox = html(doc, 'ul', 'ds-chart__rows');
  frame.append(root, centre, tip, hint, probe, emptyNote);
  const tableBox = keep(html(doc, 'div', 'ds-chart__table'));

  const mount = () => {
    // The page's caption first, then the tools, the legend, the frame, the table.
    const caption = el.querySelector(':scope > figcaption');
    const anchor = caption ? caption.nextSibling : el.firstChild;
    el.insertBefore(tools, anchor);
    el.insertBefore(legend, tools.nextSibling);
    el.insertBefore(frame, legend.nextSibling);
    if (!sourceTable(el)) el.append(tableBox);
    else tableBox.remove();
  };

  const titleText = () => {
    const caption = el.querySelector(':scope > figcaption');
    return spec.title || el.getAttribute('aria-label') || (caption?.textContent ?? '').trim();
  };

  const emitOut = (type, detail) => {
    if (destroyed) return;
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  /* Metrics from the stylesheet (computed there from the options). */
  const metrics = () => {
    const style = view?.getComputedStyle?.(probe);
    const axisStyle = view?.getComputedStyle?.(gAxes);
    return {
      measure: measurer(gAxes),
      line: lengthOf(axisStyle, 'line-height', 16) || 16,
      gap: lengthOf(style, 'padding-block-start', 8),
      bar: lengthOf(style, 'inline-size', 24) || 24,
      seam: lengthOf(style, 'padding-inline-start', 2),
      marker: lengthOf(style, 'block-size', 8) || 8,
    };
  };

  /* Roles and names. */
  /** The chart's name: its title, else its series' names (a chart made bare from a script is still named). */
  const name = () => titleText() || spec.series.map((entry) => entry.name).filter(Boolean).join(', ');
  const noRole = { role: null, tabindex: null, 'aria-roledescription': null, 'aria-label': null, 'aria-describedby': null, 'aria-valuemin': null, 'aria-valuemax': null, 'aria-valuenow': null, 'aria-valuetext': null };
  /**
   * A plot that takes the arrows is role application, described as a chart:
   * a screen reader in browse mode would keep the arrows of an img for its
   * own cursor. One that does not (no data, a sparkline without a tooltip) is
   * an img.
   */
  const interactive = (label) => ({ role: 'application', tabindex: '0', 'aria-roledescription': t('chartRole'), 'aria-label': label || null, 'aria-describedby': hint.id });
  const applyRoles = () => {
    const title = name();
    if (spec.kind === 'gauge') {
      attrs(frame, { ...noRole, role: 'meter', 'aria-label': title || null,
        'aria-valuemin': spec.min, 'aria-valuemax': spec.max ?? 100, 'aria-valuenow': current?.value ?? null,
        'aria-valuetext': current?.value === null || current?.value === undefined ? null : [formatValue(current.value, spec.format), current.zone?.label].filter(Boolean).join(', ') });
      return;
    }
    if (spec.kind === 'rows') {
      attrs(frame, noRole);
      return;
    }
    if (spec.kind === 'spark') {
      attrs(frame, spec.tooltip ? { ...noRole, ...interactive(summary()) } : { ...noRole, role: 'img', 'aria-label': summary() || null });
      return;
    }
    if (isEmpty()) {
      attrs(frame, { ...noRole, role: 'img', 'aria-label': [title, t('chartEmpty')].filter(Boolean).join(': ') });
      return;
    }
    attrs(frame, { ...noRole, ...interactive(title) });
  };

  const summary = () => {
    const entry = spec.series.find((item) => item.visible) ?? spec.series[0];
    const values = (entry?.values ?? []).filter(finite);
    if (!values.length) return name();
    const text = t('chartSummary', {
      name: titleText() || entry.name,
      first: formatValue(values[0], spec.format),
      last: formatValue(values[values.length - 1], spec.format),
      min: formatValue(minOf(values), spec.format),
      max: formatValue(maxOf(values), spec.format),
    });
    return text;
  };

  /* The legend: one toggle per series (or slice). */
  const legendItems = () => {
    if (spec.kind === 'radial' && spec.type !== 'ring') return (current?.slices ?? []).map((slice) => ({ key: slice.key, name: slice.name, slot: slice.slot, tone: null, mark: 'column', visible: slice.visible, value: slice.value, share: slice.share }));
    // A ring's series are arcs: a filled key, as a slice's.
    return spec.series.map((entry, index) => ({ key: String(index), name: entry.name, slot: entry.slot, tone: entry.tone, mark: spec.type === 'ring' ? 'column' : entry.mark, visible: entry.visible, index, value: spec.type === 'ring' ? current?.slices?.[index]?.value : undefined }));
  };

  const swatch = (item) => {
    const box = svg(doc, 'svg', { viewBox: '0 0 20 12', 'aria-hidden': 'true', focusable: 'false' }, seriesClass('ds-chart__swatch', item));
    if (item.mark === 'line') {
      box.append(svg(doc, 'path', { d: 'M1 6H19' }, 'ds-chart__swatch-line'));
      box.append(svg(doc, 'path', { d: MARKERS[Math.max(0, item.slot) % MARKERS.length](3), transform: 'translate(10 6)' }, 'ds-chart__swatch-marker'));
    } else {
      box.append(svg(doc, 'rect', { x: 4, y: 0, width: 12, height: 12 }, 'ds-chart__swatch-fill'));
    }
    return box;
  };

  const renderLegend = () => {
    const items = spec.legend && (spec.kind === 'radial' || spec.series.length > 1) ? legendItems() : [];
    legend.hidden = !items.length;
    keyed(legend, items, (item) => `${item.key}:${item.mark}:${item.slot}:${item.tone}`, (item) => {
      const li = html(doc, 'li');
      const button = html(doc, 'button', 'ds-chart__key');
      button.type = 'button';
      button.setAttribute('data-series', item.key);
      button.append(swatch(item), html(doc, 'span', 'ds-chart__key-name'));
      if (spec.kind === 'radial') button.append(html(doc, 'span', 'ds-chart__key-value'));
      li.append(button);
      return li;
    }).forEach(({ el: li, item }) => {
      const button = li.firstElementChild;
      button.setAttribute('aria-pressed', String(item.visible));
      const nameEl = button.querySelector('.ds-chart__key-name');
      if (nameEl.textContent !== item.name) nameEl.textContent = item.name;
      const valueEl = button.querySelector('.ds-chart__key-value');
      if (valueEl) {
        // A slice says its share of the whole; a ring its own value against its max.
        const text = !item.visible ? '' : spec.type === 'ring' ? formatValue(item.value, spec.format) : formatValue(item.share, 'percent');
        if (valueEl.textContent !== text) valueEl.textContent = text;
      }
    });
  };

  /* The table for screen readers (and the table view): written again only
     when the spec or the title changed, never for a resize or a toggle. */
  let tableFor = null;
  const renderTable = () => {
    const title = titleText();
    if (tableFor && tableFor.spec === spec && tableFor.title === title) return;
    tableFor = { spec, title };
    if (sourceTable(el) || !spec.table) {
      tableBox.replaceChildren();
      return;
    }
    const table = html(doc, 'table', 'ds-table');
    const caption = html(doc, 'caption', 'ds-chart__table-caption', title);
    const head = html(doc, 'thead');
    const headRow = html(doc, 'tr');
    const corner = html(doc, 'th', '', spec.x.label);
    corner.scope = 'col';
    headRow.append(corner);
    const columns = spec.kind === 'radial' && spec.type !== 'ring' ? [spec.series[0]].filter(Boolean) : spec.series;
    for (const entry of columns) {
      const th = html(doc, 'th', 'ds-num', entry.name);
      th.scope = 'col';
      headRow.append(th);
    }
    head.append(headRow);
    const body = html(doc, 'tbody');
    if (spec.type === 'ring') {
      // A ring: one row per series, its value of its max.
      body.append(...spec.series.map((entry) => {
        const tr = html(doc, 'tr');
        const th = html(doc, 'th', '', entry.name);
        th.scope = 'row';
        tr.append(th, html(doc, 'td', 'ds-num', formatValue(entry.values.find(finite) ?? null, spec.format)));
        return tr;
      }));
      headRow.replaceChildren(corner, Object.assign(html(doc, 'th', 'ds-num', ''), { scope: 'col' }));
    } else {
      spec.labels.forEach((_, i) => {
        const tr = html(doc, 'tr');
        const th = html(doc, 'th', '', formatX(spec, i));
        th.scope = 'row';
        tr.append(th, ...columns.map((entry) => html(doc, 'td', 'ds-num', formatValue(entry.values[i], spec.format))));
        body.append(tr);
      });
    }
    table.append(caption, head, body);
    tableBox.replaceChildren(table);
  };

  /* Drawing. */
  const textEl = (parent, attributes, text, cls) => {
    const node = svg(doc, 'text', attributes, cls);
    node.textContent = text;
    parent.append(node);
    return node;
  };

  const drawAxes = (lay) => {
    gGrid.replaceChildren();
    gAxes.replaceChildren();
    gRules.replaceChildren();
    gBands.replaceChildren();
    if (lay.kind !== 'cartesian' && lay.kind !== 'spark') return;
    const { plot } = lay;
    const right = plot.x + plot.width;
    const bottom = plot.y + plot.height;
    if (!lay.spark) {
      // Gridlines along the values, a stronger baseline at zero.
      for (const tick of lay.yTicks) {
        const at = round(lay.horizontal ? lay.y.map(tick.value) : lay.y.map(tick.value));
        if (lay.horizontal) gGrid.append(svg(doc, 'line', { x1: at, x2: at, y1: plot.y, y2: bottom }, 'ds-chart__gridline'));
        else gGrid.append(svg(doc, 'line', { x1: plot.x, x2: right, y1: at, y2: at }, 'ds-chart__gridline'));
      }
      if (finite(lay.baseline)) {
        const at = round(lay.baseline);
        gGrid.append(lay.horizontal ? svg(doc, 'line', { x1: at, x2: at, y1: plot.y, y2: bottom }, 'ds-chart__baseline') : svg(doc, 'line', { x1: plot.x, x2: right, y1: at, y2: at }, 'ds-chart__baseline'));
      }
      const m = current?.metrics ?? { gap: 8, line: 16 };
      // Value labels.
      if (lay.horizontal) {
        for (const tick of lay.yTicks) textEl(gAxes, { x: round(lay.y.map(tick.value)), y: round(bottom + m.gap), 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, tick.label, 'ds-chart__tick');
        for (const tick of lay.xTicks) textEl(gAxes, { x: round(plot.x - m.gap), y: round(tick.pos), 'text-anchor': 'end', 'dominant-baseline': 'central' }, tick.label, 'ds-chart__tick ds-chart__tick--category');
      } else {
        for (const tick of lay.yTicks) textEl(gAxes, { x: round(plot.x - m.gap), y: round(lay.y.map(tick.value)), 'text-anchor': 'end', 'dominant-baseline': 'central' }, tick.label, 'ds-chart__tick');
        for (const tick of lay.y2Ticks) textEl(gAxes, { x: round(right + m.gap), y: round(lay.y2.map(tick.value)), 'text-anchor': 'start', 'dominant-baseline': 'central' }, tick.label, 'ds-chart__tick');
        const width = lay.box.width;
        for (const tick of lay.xTicks) {
          const half = m.measure ? m.measure(tick.label) / 2 : 0;
          const x = clamp(tick.pos, half, width - half);
          textEl(gAxes, { x: round(x), y: round(bottom + m.gap), 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, tick.label, 'ds-chart__tick');
        }
      }
      if (lay.titles) {
        if (lay.titles.start) textEl(gAxes, { x: 0, y: 0, 'dominant-baseline': 'hanging' }, lay.titles.start, 'ds-chart__axis-title');
        if (lay.titles.end) textEl(gAxes, { x: lay.box.width, y: 0, 'text-anchor': 'end', 'dominant-baseline': 'hanging' }, lay.titles.end, 'ds-chart__axis-title');
      }
    }
    // Thresholds and annotations: lines with their word, bands as a wash.
    for (const rule of lay.rules) {
      const cls = rule.tone ? ` ds-tone-${rule.tone}` : '';
      const valueAxisHorizontal = rule.axis === 'value' ? lay.horizontal : !lay.horizontal;
      if (rule.kind === 'band') {
        const rect = valueAxisHorizontal
          ? { x: rule.from, y: plot.y, width: rule.to - rule.from, height: plot.height }
          : { x: plot.x, y: rule.from, width: plot.width, height: rule.to - rule.from };
        gBands.append(svg(doc, 'rect', Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, round(v)])), `ds-chart__zone${cls}`));
        if (rule.label && !lay.spark) {
          // Inside the band's start, pulled back where a narrow plot would push the word past its edge.
          const wide = (current?.metrics?.measure ?? estimate)(rule.label);
          const at = valueAxisHorizontal ? { x: round(Math.max(plot.x, Math.min(rule.from + 4, right - 4 - wide))), y: round(plot.y + 4), 'dominant-baseline': 'hanging' } : { x: round(right - 4), y: round(rule.from + 4), 'text-anchor': 'end', 'dominant-baseline': 'hanging' };
          textEl(gRules, at, rule.label, 'ds-chart__rule-label');
        }
        continue;
      }
      const line = valueAxisHorizontal ? { x1: rule.at, x2: rule.at, y1: plot.y, y2: bottom } : { x1: plot.x, x2: right, y1: rule.at, y2: rule.at };
      gRules.append(svg(doc, 'line', Object.fromEntries(Object.entries(line).map(([k, v]) => [k, round(v)])), `ds-chart__rule${cls}`));
      if (rule.label && !lay.spark) {
        let at;
        if (valueAxisHorizontal) {
          // Above the plot, centred on its line, inside the box.
          const half = (current?.metrics?.measure ?? estimate)(rule.label) / 2;
          at = { x: round(clamp(rule.at, half, lay.box.width - half)), y: round(plot.y - 4), 'text-anchor': 'middle' };
        } else at = { x: round(right - 4), y: round(rule.at - 4), 'text-anchor': 'end' };
        textEl(gRules, at, rule.label, 'ds-chart__rule-label');
      }
    }
  };

  const drawBars = (lay, animate) => {
    const entries = (lay.series ?? []).filter((entry) => entry.mark === 'column');
    const fresh = [];
    keyed(gBars, entries, (entry) => entry.index, (entry) => svg(doc, 'g')).forEach(({ el: g, item: entry }) => {
      attrs(g, { class: partClass(entry), 'data-series': entry.index });
      keyed(g, entry.bars, (bar) => bar.key, () => svg(doc, 'rect', {}, 'ds-chart__bar')).forEach(({ el: rect, item: bar, fresh: isNew }) => {
        attrs(rect, {
          x: round(bar.x), y: round(bar.y), width: round(Math.max(0, bar.width)), height: round(Math.max(0, bar.height)),
          class: ['ds-chart__bar', bar.down ? 'ds-chart__bar--down' : '', bar.inner ? 'ds-chart__bar--inner' : '', bar.onStack ? 'ds-chart__bar--on' : ''].filter(Boolean).join(' '),
        });
        rect.style.setProperty('--ds-share', String(round(bar.share * 1000) / 1000));
        rect.style.setProperty('--ds-chart-from', String(round(bar.from * 1000) / 1000));
        if (isNew) fresh.push(rect);
      });
    });
    // Bars that are new fill from zero; the rest glide on the share.
    if (animate && fresh.length) enterAll(fresh, 'fill', { stagger: false });
  };

  const drawMarkers = (lay, points) => {
    if (!lay.markers) {
      gMarkers.replaceChildren();
      return;
    }
    const groups = (lay.series ?? []).filter((entry) => entry.mark !== 'column' && entry.visible);
    keyed(gMarkers, groups, (entry) => entry.index, () => svg(doc, 'g')).forEach(({ el: g, item: entry }) => {
      attrs(g, { class: seriesClass('ds-chart__series', entry) });
      const pts = (points.get(entry.index) ?? []).filter((point) => finite(point.x) && finite(point.y));
      const shape = MARKERS[Math.max(0, entry.slot) % MARKERS.length](current.metrics.marker / 2);
      keyed(g, pts, (point) => point.key, () => svg(doc, 'path', { d: shape }, 'ds-chart__marker')).forEach(({ el: marker, item: point }) => {
        attrs(marker, { d: shape, transform: `translate(${round(point.x)} ${round(point.y)})` });
      });
    });
  };

  /** The lone points of a line (between two gaps), drawn as markers even without markers. */
  const lonePoints = (points) => points.filter((point, i) => finite(point.y) && !finite(points[i - 1]?.y) && !finite(points[i + 1]?.y));

  const drawPaths = (lay, frameOf) => {
    const lines = (lay.series ?? []).filter((entry) => entry.mark !== 'column');
    const curve = spec.curve;
    const pointsNow = new Map();
    keyed(gAreas, lines.filter((entry) => entry.mark === 'area'), (entry) => entry.index, () => svg(doc, 'path', {}, 'ds-chart__area')).forEach(({ el: node, item: entry }) => {
      const pts = frameOf(entry);
      attrs(node, { class: partClass(entry, 'ds-chart__area'), 'data-series': entry.index, d: entry.visible ? path(pts, { curve, area: true }) : '' });
    });
    keyed(gLines, lines, (entry) => entry.index, () => svg(doc, 'g')).forEach(({ el: g, item: entry }) => {
      const pts = frameOf(entry);
      pointsNow.set(entry.index, pts);
      attrs(g, { class: partClass(entry), 'data-series': entry.index, 'data-hidden': entry.visible ? null : '' });
      let line = g.querySelector('.ds-chart__line');
      if (!line) {
        line = svg(doc, 'path', {}, 'ds-chart__line');
        g.append(line);
      }
      attrs(line, { d: entry.visible ? path(pts, { curve }) : '' });
      const lone = entry.visible ? lonePoints(pts) : [];
      const shape = MARKERS[Math.max(0, entry.slot) % MARKERS.length](current.metrics.marker / 2);
      const holder = g.querySelector('.ds-chart__lone') ?? g.appendChild(svg(doc, 'g', {}, 'ds-chart__lone'));
      keyed(holder, lone, (point) => point.key, () => svg(doc, 'path', {}, 'ds-chart__marker')).forEach(({ el: marker, item: point }) => {
        attrs(marker, { d: shape, transform: `translate(${round(point.x)} ${round(point.y)})` });
      });
    });
    drawMarkers(lay, pointsNow);
    return pointsNow;
  };

  const drawRadial = (lay, frameOf) => {
    gBars.replaceChildren();
    const slices = lay.slices ?? [];
    const tracks = lay.type === 'ring' ? slices : [];
    keyed(gAreas, tracks, (item) => item.key, () => svg(doc, 'path', {}, 'ds-chart__track')).forEach(({ el: node, item }) => {
      attrs(node, { d: arcPath(lay.cx, lay.cy, item.inner, item.outer, 0, 2 * Math.PI) });
    });
    keyed(gLines, slices, (item) => item.key, () => svg(doc, 'path')).forEach(({ el: node, item }, position) => {
      const angles = frameOf(item);
      attrs(node, {
        class: partClass(item, 'ds-chart__slice', position),
        'data-series': item.index,
        d: arcPath(lay.cx, lay.cy, item.inner, item.outer, angles.a0 + (item.pad ?? 0), angles.a1 - (item.pad ?? 0)),
      });
    });
  };

  const drawGauge = (lay, angleNow) => {
    gBars.replaceChildren();
    gLines.replaceChildren();
    const track = svg(doc, 'path', { d: arcPath(lay.cx, lay.cy, lay.inner, lay.outer, lay.a0, lay.a1) }, 'ds-chart__track');
    gLines.append(track);
    // Zones: a thin band outside the arc, each in its tone, with a seam between.
    if (lay.zones.length) {
      const r1 = lay.outer + lay.band * 2;
      for (const zone of lay.zones) {
        gLines.append(svg(doc, 'path', { d: arcPath(lay.cx, lay.cy, r1 - lay.band, r1, zone.a0 + 0.01, zone.a1 - 0.01) }, `ds-chart__zone-arc${zone.tone ? ` ds-tone-${zone.tone}` : ''}`));
      }
    }
    const tone = lay.zone?.tone;
    gLines.append(svg(doc, 'path', { d: arcPath(lay.cx, lay.cy, lay.inner, lay.outer, lay.a0, angleNow) }, `ds-chart__slice ds-chart__value-arc${tone ? ` ds-tone-${tone}` : ''}`));
    gAxes.replaceChildren();
    for (const end of lay.ends) textEl(gAxes, { x: round(end.x), y: round(end.y), 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, end.label, 'ds-chart__tick');
  };

  const drawRows = (lay, animate) => {
    keyed(rowsBox, lay.rows, (row) => row.key, () => {
      const li = html(doc, 'li', 'ds-chart__row');
      const head = html(doc, 'span', 'ds-chart__row-head');
      head.append(html(doc, 'span', 'ds-chart__row-label'), html(doc, 'span', 'ds-chart__row-status'), html(doc, 'strong', 'ds-chart__row-value ds-num'));
      const bar = html(doc, 'span', 'ds-chart__row-bar');
      bar.setAttribute('role', 'meter');
      li.append(head, bar);
      return li;
    }).forEach(({ el: li, item: row, fresh }) => {
      li.className = `ds-chart__row${row.tone ? ` ds-tone-${row.tone}` : ''}`;
      const label = li.querySelector('.ds-chart__row-label');
      if (label.textContent !== row.label) label.textContent = row.label;
      const status = li.querySelector('.ds-chart__row-status');
      if (status.textContent !== row.status) status.textContent = row.status;
      const bar = li.querySelector('.ds-chart__row-bar');
      attrs(bar, {
        'aria-label': row.label, 'aria-valuemin': spec.min, 'aria-valuemax': lay.max,
        'aria-valuenow': finite(row.value) ? row.value : null,
        'aria-valuetext': [row.text, row.status].filter(Boolean).join(', ') || null,
      });
      bar.style.setProperty('--ds-share', String(round(row.share * 1000) / 1000));
      const value = li.querySelector('.ds-chart__row-value');
      if (animate && !fresh && finite(row.value)) countUp(value, row.value, { format: (v) => formatValue(v, spec.format) });
      else value.textContent = row.text;
      if (animate && fresh) enterAll([bar], 'fill', { stagger: false });
    });
  };

  /* The morph: one clock for every path and arc of the chart. */
  const stopMorph = () => {
    if (!morph) return;
    view?.cancelAnimationFrame?.(morph.frame);
    morph.clock?.cancel();
    morph = null;
  };

  const startClock = () => {
    const duration = motionDuration(root, '--ds-dur-glide');
    if (!(duration > 0) || typeof root.animate !== 'function' || !root.isConnected || typeof view?.requestAnimationFrame !== 'function') return null;
    try {
      const clock = root.animate([], { duration, easing: motionEasing(root, '--ds-ease-value'), id: 'ds-chart-morph' });
      clock.id = 'ds-chart-morph';
      return clock;
    } catch {
      // A curve this engine cannot read: the data lands at once.
      return null;
    }
  };

  /** The eased progress of the clock, within [0, 1] (a value never overshoots). */
  const progressOf = (clock) => {
    if (!clock || clock.playState === 'idle' || clock.playState === 'finished') return 1;
    const value = clock.effect?.getComputedTiming?.().progress;
    return value === null || value === undefined ? 0 : clamp(value, 0, 1);
  };

  /** Draws a cartesian layout; `animate` morphs the lines from what shows. */
  const paintCartesian = (lay, animate) => {
    drawAxes(lay);
    drawBars(lay, animate && !first ? true : animate);
    const lines = lay.series.filter((entry) => entry.mark !== 'column');
    // What a path draws: every point, or the layout's reduction of a long series.
    const targets = new Map(lines.map((entry) => [entry.index, entry.drawn ?? entry.points]));
    const from = new Map();
    for (const entry of lines) {
      const before = shown.get(entry.index);
      let sorted = null;
      const map = new Map();
      for (const point of targets.get(entry.index)) {
        if (!finite(point.y) && !finite(point.x)) continue;
        const known = before?.get(point.key);
        if (known) {
          map.set(point.key, known);
          continue;
        }
        sorted ??= alongAxis(before, lay.horizontal);
        map.set(point.key, entryPoint(sorted, point, lay.horizontal, lay.baseline));
      }
      from.set(entry.index, map);
    }
    const draw = (p) => {
      const now = drawPaths(lay, (entry) => (p >= 1 ? targets.get(entry.index) : blendPoints(from.get(entry.index) ?? new Map(), targets.get(entry.index), p)));
      shown = new Map([...now].map(([index, pts]) => [index, new Map(pts.filter((point) => finite(point.x) && finite(point.y)).map((point) => [point.key, point]))]));
    };
    runMorph(animate && lines.length > 0, draw);
  };

  const paintRadial = (lay, animate) => {
    drawAxes(lay);
    const from = new Map();
    for (const item of lay.slices) {
      const before = arcsShown.get(item.key);
      const at = before ?? (first ? { a0: 0, a1: 0 } : { a0: item.a0, a1: item.a0 });
      from.set(item.key, at);
    }
    const draw = (p) => {
      const now = new Map();
      drawRadial(lay, (item) => {
        const a = from.get(item.key);
        const frame = p >= 1 ? { a0: item.a0, a1: item.a1 } : { a0: a.a0 + (item.a0 - a.a0) * p, a1: a.a1 + (item.a1 - a.a1) * p };
        now.set(item.key, frame);
        return frame;
      });
      arcsShown = now;
    };
    runMorph(animate, draw);
    // The centre: a donut's total (or the ring's first value) counts.
    if (lay.type === 'donut' || lay.type === 'ring') {
      const value = lay.type === 'ring' ? lay.slices[0]?.value ?? null : lay.total;
      const format = lay.type === 'ring' ? spec.format : spec.format;
      centre.hidden = false;
      const label = spec.label ?? (lay.type === 'ring' ? lay.slices[0]?.name ?? '' : t('chartTotal'));
      if (centreLabel.textContent !== label) centreLabel.textContent = label;
      if (animate && finite(value)) countUp(centreValue, value, { format: (v) => formatValue(v, format) });
      else centreValue.textContent = formatValue(value, format);
    } else centre.hidden = true;
  };

  const paintGauge = (lay, animate) => {
    const before = arcsShown.get('value')?.a1 ?? lay.a0;
    const draw = (p) => {
      const angle = p >= 1 ? lay.angle : before + (lay.angle - before) * p;
      drawGauge(lay, angle);
      arcsShown = new Map([['value', { a0: lay.a0, a1: angle }]]);
    };
    runMorph(animate, draw);
    centre.hidden = false;
    const label = [lay.zone?.label, spec.label].filter(Boolean).join(' · ');
    if (centreLabel.textContent !== label) centreLabel.textContent = label;
    if (animate && finite(lay.value)) countUp(centreValue, lay.value, { format: (v) => formatValue(v, spec.format) });
    else centreValue.textContent = formatValue(lay.value, spec.format);
  };

  const runMorph = (animate, draw) => {
    stopMorph();
    const clock = animate ? startClock() : null;
    if (!clock) {
      draw(1);
      return;
    }
    const run = { clock, frame: 0 };
    morph = run;
    const tick = () => {
      if (morph !== run) return;
      const p = progressOf(clock);
      draw(p);
      if (p >= 1 || clock.playState === 'finished' || clock.playState === 'idle') {
        draw(1);
        if (morph === run) morph = null;
        return;
      }
      run.frame = view.requestAnimationFrame(tick);
    };
    // The last frame lands with the clock, before anything that waits on it (DS.motion.settled) reads the chart.
    clock.finished?.then(() => {
      if (morph !== run) return;
      view.cancelAnimationFrame?.(run.frame);
      draw(1);
      morph = null;
    }, () => {});
    draw(progressOf(clock));
    run.frame = view.requestAnimationFrame(tick);
  };

  /** Interrupted: freeze what shows so the next morph starts from it. */
  const freeze = () => { stopMorph(); };

  /** Lays the chart out at its size and draws it (`animate`: morph and glide to it). */
  const render = (animate) => {
    if (destroyed) return;
    const wanted = typeClasses();
    if (wanted.join(' ') !== applied.join(' ')) {
      for (const name of applied) if (!wanted.includes(name)) el.classList.remove(name);
      for (const name of wanted) {
        own(el, 'classes', name);
        el.classList.add(name);
      }
      applied = wanted;
    }
    if (spec.kind === 'rows') {
      if (!rowsBox.isConnected) frame.append(rowsBox);
      root.remove();
      const lay = layout(spec, 0, 0);
      current = { ...lay, metrics: metrics() };
      drawRows(lay, animate);
      renderLegend();
      renderTable();
      applyRoles();
      tools.hidden = true;
      return;
    }
    rowsBox.remove();
    if (!root.isConnected) frame.prepend(root);
    const rect = frame.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    size = { width: Math.round(rect.width), height: Math.round(rect.height) };
    const m = metrics();
    freeze();
    const lay = layout({ ...spec, hiddenSlices: [...hiddenSlices] }, size.width, size.height, m);
    current = { ...lay, metrics: m };
    attrs(root, { viewBox: `0 0 ${size.width} ${size.height}`, width: size.width, height: size.height });
    // Lines and areas stay inside the plot (and a marker's reach); arcs use the whole box.
    if (lay.plot) attrs(clipRect, { x: round(lay.plot.x - m.marker), y: round(lay.plot.y - m.marker), width: round(lay.plot.width + 2 * m.marker), height: round(lay.plot.height + 2 * m.marker) });
    else attrs(clipRect, { x: 0, y: 0, width: size.width, height: size.height });
    const empty = isEmpty();
    emptyNote.textContent = empty ? t('chartEmpty') : '';
    tools.hidden = !spec.table || empty;
    toggle.setAttribute('aria-label', t('chartTableView'));
    toggle.setAttribute('data-tip', t('chartTableView'));
    hint.textContent = t(spec.kind === 'radial' ? 'chartKeysSlices' : spec.horizontal ? 'chartKeysBars' : 'chartKeys');
    if (lay.kind === 'radial' || lay.kind === 'gauge') {
      // The figure sits on the centre of the arcs (a gauge's is above the middle).
      centre.style.setProperty('--ds-chart-cx', `${round(lay.cx)}px`);
      centre.style.setProperty('--ds-chart-cy', `${round(lay.cy)}px`);
      centre.style.setProperty('--ds-chart-hole', `${round(Math.max(0, lay.inner) * 2)}px`);
    }
    if (lay.kind === 'radial') {
      gAreas.replaceChildren();
      gMarkers.replaceChildren();
      paintRadial(lay, animate);
    } else if (lay.kind === 'gauge') {
      gAreas.replaceChildren();
      gMarkers.replaceChildren();
      paintGauge(lay, animate);
    } else {
      centre.hidden = true;
      paintCartesian(lay, animate);
    }
    renderLegend();
    if (empty) legend.hidden = true;
    renderTable();
    applyRoles();
    if (cursor.active) showCursor(false);
    first = false;
  };

  /* Cursor, tooltip, announcements. */
  const pointCount = () => (current?.kind === 'radial' ? current.slices.length : spec.labels.length);
  const visibleSeries = () => spec.series.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.visible);

  const pointDetail = () => {
    const i = cursor.index;
    if (current?.kind === 'radial') {
      const slice = current.slices[i];
      return slice ? { index: i, series: i, key: slice.key, label: slice.name } : null;
    }
    return i < 0 ? null : { index: i, series: cursor.series, key: spec.keys[i], label: formatX(spec, i) };
  };

  const readout = () => {
    const i = cursor.index;
    if (current?.kind === 'radial') {
      const slice = current.slices[i];
      if (!slice) return null;
      const value = current.type === 'ring' ? formatValue(slice.value, spec.format) : `${formatValue(slice.value, spec.format)} (${formatValue(slice.share, 'percent')})`;
      return { title: '', rows: [{ entry: { slot: slice.slot, tone: slice.tone, mark: 'column' }, name: slice.name, value, hidden: !slice.visible }] };
    }
    const rows = visibleSeries()
      .filter(({ index }) => cursor.series < 0 || index === cursor.series)
      .map(({ entry }) => ({ entry, name: entry.name, value: entry.values[i] === null ? '–' : formatValue(entry.values[i], spec.stack === 'percent' ? spec.format : spec.format) }));
    if (spec.stack && cursor.series < 0 && rows.length > 1) {
      const total = visibleSeries().reduce((sum, { entry }) => sum + (entry.values[i] ?? 0), 0);
      rows.push({ entry: null, name: t('chartTotal'), value: formatValue(total, spec.format) });
    }
    return { title: formatX(spec, i), rows };
  };

  const fillTip = (data) => {
    const children = [];
    if (data.title) children.push(html(doc, 'span', 'ds-chart__tip-title', data.title));
    for (const row of data.rows) {
      const line = html(doc, 'span', 'ds-chart__tip-row');
      if (row.entry) {
        const key = svg(doc, 'svg', { viewBox: '0 0 16 4', 'aria-hidden': 'true', focusable: 'false' }, seriesClass('ds-chart__tip-key', row.entry));
        key.append(svg(doc, 'path', { d: 'M1 2H15' }, row.entry.mark === 'column' ? 'ds-chart__tip-key-bar' : 'ds-chart__swatch-line'));
        line.append(key);
      } else line.append(html(doc, 'span', 'ds-chart__tip-gap'));
      line.append(html(doc, 'strong', 'ds-chart__tip-value', row.value), html(doc, 'span', 'ds-chart__tip-name', row.name));
      children.push(line);
    }
    tip.replaceChildren(...children);
  };

  const announcement = () => {
    const data = readout();
    if (!data) return '';
    const values = data.rows.map((row) => `${row.name} ${row.value}`).join(', ');
    return data.title ? t('chartPoint', { x: data.title, values }) : values;
  };

  const showCursor = (fromKeyboard, pointer = null) => {
    if (!current || cursor.index < 0 || cursor.index >= pointCount()) {
      hideCursor();
      return;
    }
    const lay = current;
    let anchor;
    dotsFor(null);
    if (lay.kind === 'radial') {
      const slice = lay.slices[cursor.index];
      const mid = (slice.a0 + slice.a1) / 2;
      const r = (slice.inner + slice.outer) / 2;
      anchor = { x: lay.cx + r * Math.sin(mid), y: lay.cy - r * Math.cos(mid) };
      marks = { series: -1, slice: cursor.index };
      gLines.querySelectorAll('.ds-chart__slice').forEach((node, i) => node.classList.toggle('ds-chart__slice--active', i === cursor.index));
      attrs(cursorLine, { x1: null, x2: null, y1: null, y2: null });
      cursorLine.classList.remove('ds-chart__cursor--on');
    } else {
      const pos = lay.positions[cursor.index];
      const { plot } = lay;
      const columnsOnly = lay.series.every((entry) => entry.mark === 'column');
      if (columnsOnly) {
        const half = (lay.band || 0) / 2;
        attrs(hoverRect, lay.horizontal
          ? { x: round(plot.x), y: round(pos - half), width: round(plot.width), height: round(half * 2) }
          : { x: round(pos - half), y: round(plot.y), width: round(half * 2), height: round(plot.height) });
        hoverRect.classList.add('ds-chart__band--on');
        cursorLine.classList.remove('ds-chart__cursor--on');
      } else {
        attrs(cursorLine, lay.horizontal ? { x1: round(plot.x), x2: round(plot.x + plot.width), y1: round(pos), y2: round(pos) } : { x1: round(pos), x2: round(pos), y1: round(plot.y), y2: round(plot.y + plot.height) });
        cursorLine.classList.add('ds-chart__cursor--on');
        hoverRect.classList.remove('ds-chart__band--on');
      }
      dotsFor(cursor.index);
      marks = { series: cursor.series, slice: -1 };
      for (const g of root.querySelectorAll('.ds-chart__bars > [data-series], .ds-chart__lines > [data-series], .ds-chart__areas > [data-series]')) {
        g.classList.toggle('ds-chart__series--dim', cursor.series >= 0 && Number(g.getAttribute('data-series')) !== cursor.series);
      }
      const ys = lay.series.filter((entry) => entry.visible && (cursor.series < 0 || entry.index === cursor.series)).map((entry) => (lay.horizontal ? entry.points[cursor.index]?.x : entry.points[cursor.index]?.y)).filter(finite);
      const across = pointer ? (lay.horizontal ? pointer.x : pointer.y) : ys.length ? Math.min(...ys) : plot.y + plot.height / 2;
      anchor = lay.horizontal ? { x: across, y: pos } : { x: pos, y: across };
    }
    if (spec.tooltip) {
      const data = readout();
      if (data) {
        fillTip(data);
        tip.setAttribute('data-state', 'open');
        const tipBox = { width: tip.offsetWidth, height: tip.offsetHeight };
        const bounds = { left: 0, top: 0, right: size.width, bottom: size.height };
        const rect = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
        const placed = computePlacement(rect, tipBox, bounds, { side: 'end', align: 'center', offset: 12, padding: 0, flip: 'room', size: false });
        const x = clamp(placed.x, 0, Math.max(0, size.width - tipBox.width));
        const y = clamp(placed.y, 0, Math.max(0, size.height - tipBox.height));
        tip.style.translate = `${round(x)}px ${round(y)}px`;
      }
    }
    if (fromKeyboard) announce(announcement());
  };

  const dotsFor = (index) => {
    if (index === null || !current?.series) {
      gDots.replaceChildren();
      return;
    }
    const entries = current.series.filter((entry) => entry.visible && entry.mark !== 'column' && (cursor.series < 0 || entry.index === cursor.series));
    keyed(gDots, entries, (entry) => entry.index, () => svg(doc, 'g')).forEach(({ el: g, item: entry }) => {
      attrs(g, { class: seriesClass('ds-chart__series', entry) });
      const point = shown.get(entry.index)?.get(spec.keys[index]) ?? entry.points[index];
      const marker = g.firstElementChild ?? g.appendChild(svg(doc, 'path', {}, 'ds-chart__dot'));
      if (!point || !finite(point.y) || !finite(point.x)) {
        attrs(marker, { d: null });
        return;
      }
      attrs(marker, { d: MARKERS[Math.max(0, entry.slot) % MARKERS.length](current.metrics.marker / 2 + 1), transform: `translate(${round(point.x)} ${round(point.y)})` });
    });
  };

  const hideCursor = () => {
    marks = { series: -1, slice: -1 };
    tip.removeAttribute('data-state');
    cursorLine.classList.remove('ds-chart__cursor--on');
    hoverRect.classList.remove('ds-chart__band--on');
    gLines.querySelectorAll('.ds-chart__slice--active').forEach((node) => node.classList.remove('ds-chart__slice--active'));
    root.querySelectorAll('.ds-chart__series--dim').forEach((node) => node.classList.remove('ds-chart__series--dim'));
    gDots.replaceChildren();
  };

  const moveTo = (index, series, fromKeyboard, pointer = null) => {
    const count = pointCount();
    if (!count) return;
    const next = clamp(index, 0, count - 1);
    const changed = next !== cursor.index || series !== cursor.series;
    cursor = { index: next, series, active: true };
    showCursor(fromKeyboard, pointer);
    if (changed) emitOut('point', pointDetail());
  };

  const pointerIndex = (event) => {
    const box = frame.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    if (!current) return null;
    if (current.kind === 'radial') {
      const dx = x - current.cx;
      const dy = y - current.cy;
      const r = Math.hypot(dx, dy);
      const hit = current.type === 'ring'
        ? current.slices.findIndex((slice) => r >= slice.inner - 2 && r <= slice.outer + 2)
        : r <= current.outer + 2 && r >= current.inner - 2 ? sliceAt(current.slices, Math.atan2(dx, -dy)) : -1;
      return hit < 0 ? null : { index: hit, x, y };
    }
    if (!current.plot) return null;
    const { plot } = current;
    if (x < plot.x - 8 || x > plot.x + plot.width + 8 || y < plot.y - 8 || y > plot.y + plot.height + 8) return null;
    const index = nearest(current.positions, current.horizontal ? y : x);
    return index < 0 ? null : { index, x, y };
  };

  /* Events. */
  const options = { signal };
  /*
   * The pointer listeners come in a microtask, after the task that made the
   * chart (no event can come before it). In WebKit, once an SVG <text> (a
   * tick) is in the page, every pointer, touch or wheel listener added
   * costs a layout of the whole page at the next layout read: the first
   * render's own read, and the next chart's, paid it once per chart. Added
   * after the task, the charts a page makes together pay it once.
   */
  const pointerEvents = () => {
    if (destroyed) return;
    frame.addEventListener('pointermove', (event) => {
      if (!spec.tooltip || viewMode !== 'chart') return;
      const hit = pointerIndex(event);
      if (!hit) {
        if (!frame.contains(doc.activeElement)) hideCursor();
        return;
      }
      moveTo(hit.index, -1, false, { x: hit.x, y: hit.y });
    }, options);
    frame.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      // The keyboard's cursor stays when the pointer leaves; a click's focus does not hold it.
      if (!frame.matches(':focus-visible')) {
        cursor.active = false;
        hideCursor();
      } else showCursor(false);
    }, options);
    frame.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || !spec.tooltip) return;
      const hit = pointerIndex(event);
      if (hit) moveTo(hit.index, -1, false, { x: hit.x, y: hit.y });
    }, options);
  };
  queueMicrotask(pointerEvents);
  frame.addEventListener('click', (event) => {
    const hit = pointerIndex(event);
    if (!hit || spec.kind === 'gauge' || spec.kind === 'rows') return;
    cursor = { index: hit.index, series: -1, active: true };
    emitOut('select', pointDetail());
  }, options);
  frame.addEventListener('focus', () => {
    if (spec.kind === 'gauge' || spec.kind === 'rows') return;
    if (frame.matches(':focus-visible') || cursor.index >= 0) {
      const count = pointCount();
      moveTo(cursor.index >= 0 ? cursor.index : count - 1, cursor.series, true);
    }
  }, options);
  frame.addEventListener('blur', () => {
    cursor.active = false;
    hideCursor();
  }, options);
  frame.addEventListener('keydown', (event) => {
    if (!KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (spec.kind === 'gauge' || spec.kind === 'rows') return;
    const count = pointCount();
    if (!count) return;
    if (event.key === 'Escape') {
      if (!cursor.active) return;
      cursor.active = false;
      hideCursor();
      // Escape is the cursor's here (an overlay around the chart keeps
      // open, as it reads defaultPrevented); the next one reaches it.
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const radial = current?.kind === 'radial';
    const page = Math.max(1, Math.round(count / 10));
    let { index, series } = cursor;
    if (index < 0) index = count - 1;
    const visible = visibleSeries().map(({ index: i }) => i);
    const prev = radial || current?.horizontal ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft'];
    const next = radial || current?.horizontal ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight'];
    if (event.key === 'Enter') {
      emitOut('select', pointDetail());
      return;
    }
    if (prev.includes(event.key)) index -= 1;
    else if (next.includes(event.key)) index += 1;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = count - 1;
    else if (event.key === 'PageUp') index -= page;
    else if (event.key === 'PageDown') index += page;
    else if (!radial && visible.length > 1 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      // Through the series at this point, then back to all of them.
      const order = [-1, ...visible];
      const at = order.indexOf(series);
      series = order[(at + (event.key === 'ArrowDown' ? 1 : order.length - 1)) % order.length];
    }
    moveTo(clamp(index, 0, count - 1), series, true);
  }, options);

  /** A donut's or pie's legend shows and hides slices, not series. */
  const slicesToggle = () => spec.kind === 'radial' && spec.type !== 'ring';

  /** Shows or hides a slice (never the last one shown); returns whether it shows. */
  const toggleSlice = (slice, visible) => {
    const want = visible === undefined ? !slice.visible : Boolean(visible);
    if (want === slice.visible) return slice.visible;
    if (!want && (current?.slices ?? []).filter((item) => item.visible).length <= 1) return slice.visible;
    if (want) hiddenSlices.delete(slice.key);
    else hiddenSlices.add(slice.key);
    render(true);
    announce(t(want ? 'chartShown' : 'chartHidden', { series: slice.name }));
    emitOut('toggle', { series: slice.index, name: slice.name, visible: want });
    return want;
  };

  legend.addEventListener('click', (event) => {
    const button = event.target.closest?.('.ds-chart__key');
    if (!button || !legend.contains(button)) return;
    const key = button.getAttribute('data-series');
    if (slicesToggle()) {
      const slice = (current?.slices ?? []).find((item) => item.key === key);
      if (slice) toggleSlice(slice);
      return;
    }
    api.toggle(Number(key));
  }, options);

  toggle.addEventListener('click', () => api.view(viewMode === 'chart' ? 'table' : 'chart'), options);

  /* Size and the source table. */
  let resizer = null;
  if (typeof view?.ResizeObserver === 'function') {
    resizer = new view.ResizeObserver(() => {
      if (spec.kind === 'rows' || viewMode !== 'chart') return;
      const rect = frame.getBoundingClientRect();
      // The first call reports the size of the first render: keep its motion.
      if (Math.round(rect.width) === size.width && Math.round(rect.height) === size.height) return;
      if (rect.width > 0) render(false);
    });
    resizer.observe(frame);
  }
  let watcher = null;
  const watchTable = () => {
    watcher?.disconnect();
    const table = sourceTable(el);
    if (!table || typeof view?.MutationObserver !== 'function') return;
    let queued = false;
    watcher = new view.MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!destroyed) apply(specOf(el), true);
      });
    });
    watcher.observe(table, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-value', 'datetime'] });
  };

  const apply = (next, animate) => {
    input = { ...(next ?? {}) };
    const before = spec;
    spec = normalize(input, before);
    if (before.type !== spec.type || before.kind !== spec.kind) {
      shown = new Map();
      arcsShown = new Map();
    }
    if (cursor.index >= pointCount()) cursor.index = -1;
    render(animate);
  };

  const api = {
    /** The spec as given, with each series' visibility. */
    get() {
      return { ...input, type: spec.type, series: spec.series.map((entry) => ({ ...((input.series ?? [])[spec.series.indexOf(entry)] ?? {}), name: entry.name, values: [...entry.values], visible: entry.visible })), labels: [...spec.labels] };
    },
    /** New data or options: merged over the current spec; lines morph, bars glide, figures count. */
    set(next) {
      apply({ ...input, ...(next ?? {}) }, true);
      emitOut('change', { spec: api.get() });
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    /**
     * Shows or hides a series (by index or name), on a donut or pie a slice
     * (by index or label), as its legend key does; returns whether it shows.
     * Never hides the last one.
     */
    toggle(series, visible) {
      if (slicesToggle()) {
        const slices = current?.slices ?? [];
        const slice = typeof series === 'number' ? slices[series] : slices.find((item) => item.name === series || item.key === String(series));
        return slice ? toggleSlice(slice, visible) : false;
      }
      const index = typeof series === 'number' ? series : spec.series.findIndex((entry) => entry.name === series);
      const entry = spec.series[index];
      if (!entry) return false;
      const want = visible === undefined ? !entry.visible : Boolean(visible);
      if (want === entry.visible) return entry.visible;
      if (!want && spec.series.filter((item) => item.visible).length <= 1) return entry.visible;
      entry.visible = want;
      if (input.series?.[index]) input.series[index] = { ...input.series[index], visible: want };
      if (cursor.series === index) cursor.series = -1;
      render(true);
      announce(t(want ? 'chartShown' : 'chartHidden', { series: entry.name }));
      emitOut('toggle', { series: index, name: entry.name, visible: want });
      return want;
    },
    /** 'chart' or 'table': which one shows; returns the view in force. */
    view(mode) {
      if (mode !== 'chart' && mode !== 'table') return viewMode;
      if (mode === viewMode) return viewMode;
      viewMode = mode;
      el.setAttribute('data-state', mode);
      toggle.setAttribute('aria-pressed', String(mode === 'table'));
      hideCursor();
      emitOut('view', { view: mode });
      if (mode === 'chart') render(false);
      return viewMode;
    },
    /** Moves the cursor to a point (and a series) as the keyboard does, with its announcement. */
    focus(index, series = -1) {
      moveTo(index, series, true);
    },
    /** Reads the attributes and the table again (the attribute path calls it). */
    update() {
      apply(specOf(el), true);
      watchTable();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopMorph();
      resizer?.disconnect();
      watcher?.disconnect();
      listeners.clear();
      tools.remove();
      legend.remove();
      frame.remove();
      tableBox.remove();
      for (const name of applied) el.classList.remove(name);
      el.removeAttribute('data-state');
    },
  };

  mount();
  watchTable();
  render(true);
  return api;
}

define('chart', {
  attribute: 'data-ds-chart',
  attributes: ['data-ds-config'],
  init(el, ctx) {
    return controller(el, specOf(el), ctx.signal);
  },
});

/**
 * Draws a chart into `el` from `spec` (the same shape as the JSON of
 * data-ds-chart); the same controller the attribute path makes.
 * @param {Element} el
 * @param {object} spec
 */
export function create(el, spec) {
  return controller(el, spec ?? specOf(el), undefined);
}
