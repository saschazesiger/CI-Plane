/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Formatted value (DS.formatted): a number, a count in short form, a
 * percentage, an amount of money, a size in bytes or a length of time,
 * written through Intl (js/format.js) in the page's locale, with the exact
 * value in a tooltip where the text rounds it.
 *
 *   <span data-ds-format="bytes" data-ds-value="1536"></span>                 1.5 kB   (tip: 1,536 bytes)
 *   <span data-ds-format="currency" data-ds-format-currency="EUR">1234.5</span>  €1,234.50
 *   <span data-ds-format="compact">1284902</span>                              1.3M     (tip: 1,284,902)
 *   <span data-ds-format="percent" data-ds-format-signed>0.042</span>          +4.2%
 *   <span data-ds-format="duration" data-ds-format-style="clock">3725000</span>  1:02:05
 *   const value = DS.formatted.create(el, { kind: 'bytes', value: 1536 });
 *   value.set(2048);
 *   DS.formatted.text(1536, { kind: 'bytes' });                               '1.5 kB'
 *
 * The raw value: data-ds-value, else the element's own text when the
 * behaviour starts (a server that writes the raw figure keeps working
 * without script). A page that re-renders with DS.dom.morphHtml and puts a
 * new raw figure in the text (or a new data-ds-value) gets it formatted
 * before paint; the element's MutationObserver sees the patch.
 *
 * Options as attributes (`options` of create() go first): data-ds-format
 * (the kind: number, compact, percent, currency, bytes, duration),
 * data-ds-format-currency (an ISO 4217 code), -digits (the most fraction
 * digits), -base (1024 for KiB), -style (duration: short, long, narrow,
 * clock; compact: short, long), -signed (a sign also on a gain: deltas),
 * -tip ("off": no tooltip). The locale is DS.config()'s, else the lang of
 * <html>; a new locale rewrites every value.
 *
 * The tip: where the text rounds the value (compact, bytes, duration,
 * percent, digits), data-tip gets the exact value ("1,536 bytes"), owned
 * state so a re-render keeps it, unless the page wrote its own. The
 * tooltips of DS.overlay show it on hover and on keyboard focus.
 *
 * The controller: get() gives { value, text }, set(value) writes a new raw
 * value, on('change', fn) runs when the text changed, update() reads the
 * attributes again, destroy() stops and removes what it wrote (the text
 * stays). Events: ds:change on the element after set().
 *
 * ES2022. No Progressive: features.
 */
import { define, emit } from './core.js';
import { own, disown } from './dom.js';
import { number, percent, currency, bytes, duration } from './format.js';

const KINDS = Object.freeze(['number', 'compact', 'percent', 'currency', 'bytes', 'duration']);

/** The data-ds-format-* attributes that name an option. */
const OPTION_ATTRIBUTES = Object.freeze(['currency', 'digits', 'base', 'style', 'signed', 'tip']);

/** The most digits a tip shows: the exact value, short of float noise. */
const EXACT_DIGITS = 6;

/** `value` as a finite number, or null. */
function parse(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The Intl options of the number kinds from the component's options. */
function numberOptions(options) {
  const out = {};
  if (options.locale) out.locale = options.locale;
  if (options.signed) out.signDisplay = 'exceptZero';
  const digits = Number.parseInt(String(options.digits ?? ''), 10);
  if (Number.isInteger(digits) && digits >= 0 && digits <= 20) {
    out.maximumFractionDigits = digits;
    if (options.kind === 'currency') out.minimumFractionDigits = Math.min(digits, 2);
  }
  return out;
}

/**
 * The text of a raw value for a kind: '' for what is no number, or for an
 * unknown kind's bad value. A bad currency code falls back to the number.
 * @param {number|string|null|undefined} value
 * @param {{ kind?: string, currency?: string, digits?: number|string, base?: number|string, style?: string, signed?: boolean, locale?: string }} [options]
 * @returns {string}
 */
export function text(value, options = {}) {
  const raw = parse(value);
  if (raw === null) return '';
  const kind = KINDS.includes(options.kind ?? '') ? options.kind : 'number';
  const settings = numberOptions({ ...options, kind });
  switch (kind) {
    case 'compact':
      return number(raw, { ...settings, notation: 'compact', compactDisplay: options.style === 'long' ? 'long' : 'short' });
    case 'percent':
      return percent(raw, { maximumFractionDigits: 1, ...settings });
    case 'currency':
      try {
        return currency(raw, String(options.currency || 'USD').toUpperCase(), settings);
      } catch {
        return number(raw, settings);
      }
    case 'bytes':
      return bytes(raw, { ...settings, base: Number(options.base) === 1024 ? 1024 : 1000 });
    case 'duration': {
      const style = ['short', 'long', 'narrow', 'clock'].includes(options.style ?? '') ? options.style : 'short';
      return duration(raw, { locale: options.locale, style });
    }
    default:
      return number(raw, settings);
  }
}

/**
 * The exact value for the tip, or '' where the text already is exact.
 * @param {number|string|null|undefined} value
 * @param {{ kind?: string, locale?: string, currency?: string, style?: string, base?: number|string, digits?: number|string, signed?: boolean }} [options]
 * @returns {string}
 */
export function exact(value, options = {}) {
  const raw = parse(value);
  if (raw === null) return '';
  const kind = KINDS.includes(options.kind ?? '') ? options.kind : 'number';
  const locale = { ...(options.locale ? { locale: options.locale } : {}), ...(options.signed ? { signDisplay: 'exceptZero' } : {}) };
  let full;
  if (kind === 'bytes') full = number(raw, { ...locale, signDisplay: 'auto', style: 'unit', unit: 'byte', unitDisplay: 'long', maximumFractionDigits: 0 });
  else if (kind === 'duration') full = duration(raw, { locale: options.locale, style: 'long', parts: 5 });
  else if (kind === 'percent') full = percent(raw, { ...locale, maximumFractionDigits: EXACT_DIGITS });
  else if (kind === 'currency') {
    try {
      full = currency(raw, String(options.currency || 'USD').toUpperCase(), { ...locale, maximumFractionDigits: Math.max(2, EXACT_DIGITS) });
    } catch {
      full = number(raw, { ...locale, maximumFractionDigits: EXACT_DIGITS });
    }
  } else full = number(raw, { ...locale, maximumFractionDigits: EXACT_DIGITS });
  return full === text(raw, options) ? '' : full;
}

function controller(el, given, signal) {
  const listeners = new Set();
  let live = true;
  let written = '';
  let wroteTip = false;
  let value = null;

  const setting = (name) => {
    if (given[name] !== undefined) return given[name];
    const attribute = `data-ds-format-${name}`;
    if (!el.hasAttribute(attribute)) return undefined;
    const read = el.getAttribute(attribute);
    return name === 'signed' ? read !== 'false' : read;
  };
  const settings = () => {
    const out = { kind: given.kind ?? el.getAttribute('data-ds-format') ?? 'number' };
    for (const name of OPTION_ATTRIBUTES) {
      const read = setting(name);
      if (read !== undefined && name !== 'tip') out[name] = read;
    }
    if (given.locale) out.locale = given.locale;
    return out;
  };
  const source = () => (el.hasAttribute('data-ds-value') ? el.getAttribute('data-ds-value') : value);

  const writeTip = (tip) => {
    const off = given.tip === false || setting('tip') === 'off';
    if (off || !tip) {
      if (wroteTip) {
        wroteTip = false;
        el.removeAttribute('data-tip');
        disown(el, 'attrs', 'data-tip');
      }
      return;
    }
    if (!wroteTip) {
      if (el.hasAttribute('data-tip')) return;
      wroteTip = true;
      own(el, 'attrs', 'data-tip');
    }
    if (el.getAttribute('data-tip') !== tip) el.setAttribute('data-tip', tip);
  };

  const render = () => {
    const current = settings();
    const raw = source();
    const next = text(raw, current);
    writeTip(exact(raw, current));
    if (parse(raw) === null) return false;
    if (el.textContent === next) {
      written = next;
      return false;
    }
    if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) el.firstChild.nodeValue = next;
    else el.textContent = next;
    written = next;
    watcher?.takeRecords();
    for (const fn of [...listeners]) fn({ value: parse(raw), text: next });
    return true;
  };

  // Without data-ds-value the text is the raw value, read once; a later
  // text that is not ours is a new raw value (a re-render patched it).
  value = given.value !== undefined ? given.value : el.textContent;
  const View = el.ownerDocument?.defaultView ?? globalThis;
  const watcher = typeof View.MutationObserver === 'function' ? new View.MutationObserver(() => {
    if (!live) return;
    const shown = el.textContent;
    if (shown !== written && !el.hasAttribute('data-ds-value')) value = shown;
    render();
  }) : null;
  watcher?.observe(el, { childList: true, characterData: true, subtree: true });
  const relocale = (/** @type {CustomEvent} */ event) => {
    if (event.detail?.changed?.includes('locale')) render();
  };
  el.ownerDocument?.addEventListener?.('ds:config', relocale, signal ? { signal } : undefined);
  render();

  return {
    get() {
      return { value: parse(source()), text: el.textContent ?? '' };
    },
    set(next) {
      if (el.hasAttribute('data-ds-value')) el.setAttribute('data-ds-value', next === null || next === undefined ? '' : String(next));
      value = next;
      if (render() && live) emit(el, 'change', { value: parse(next), text: written });
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      if (live) render();
    },
    destroy() {
      if (!live) return;
      live = false;
      watcher?.disconnect();
      el.ownerDocument?.removeEventListener?.('ds:config', relocale);
      listeners.clear();
      if (wroteTip) {
        wroteTip = false;
        el.removeAttribute('data-tip');
        disown(el, 'attrs', 'data-tip');
      }
    },
  };
}

define('formatted', {
  attribute: 'data-ds-format',
  attributes: ['data-ds-value', ...OPTION_ATTRIBUTES.map((name) => `data-ds-format-${name}`)],
  init(el, ctx) {
    return controller(el, {}, ctx.signal);
  },
});

/**
 * A formatted value driven from the page; the same controller the
 * attribute path makes. `options` go before the attributes.
 * @param {Element} el
 * @param {{ kind?: string, value?: number|string, currency?: string, digits?: number|string, base?: number|string, style?: string, signed?: boolean, tip?: boolean, locale?: string }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options, null);
}
