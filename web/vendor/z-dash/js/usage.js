/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The usage meter (DS.usage): what an assistant or agent used (tokens, and
 * what they cost) against a budget, as a meter with its figures and, near
 * or over the budget, a status with an icon and a word.
 *
 *   <section class="ds-usage" data-ds-usage data-ds-usage-used="182400" data-ds-usage-budget="250000"
 *            data-ds-usage-cost="3.12" data-ds-usage-cost-budget="5" data-ds-usage-currency="USD"> ... </section>
 *   const usage = DS.usage.create(el, { used: 182400, budget: 250000 });
 *   usage.set({ used: 241000, cost: 4.1 });
 *
 * Attributes (DS.init(); a change of one is read again): data-ds-usage-used
 * (tokens used), data-ds-usage-budget (the token budget), data-ds-usage-cost
 * (what they cost), data-ds-usage-cost-budget (the money budget),
 * data-ds-usage-currency (ISO 4217, default USD) and data-ds-usage-warn
 * (the share from which it is near the budget, default 0.8). set() drives
 * it from the page and never writes those attributes.
 *
 * What it writes: the share (the larger of tokens and cost against their
 * budgets) as --ds-share on the .ds-usage__meter (a .ds-meter, role meter,
 * with aria-valuenow and aria-valuetext; hidden without a budget) and its
 * tone (.ds-tone-warning near, .ds-tone-error over); the text of .ds-usage__value ("182.4K of
 * 250K tokens") and .ds-usage__cost ("$3.12 of $5.00"); data-state="near"
 * or "over" on the root and, in .ds-usage__status, an icon and the word
 * (strings usageNear, usageOver), which it also announces once when the
 * state gets worse.
 *
 * The controller: get() ({ used, budget, cost, costBudget, currency,
 * share, state }), set(changes), on('change', fn), destroy(); ds:change
 * with that state after a set() that changed something.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { currency as money, number, percent } from './format.js';
import { announce } from './a11y.js';
import { alert, alertCircle, iconElement } from './icons.js';
import { tokensText } from './thinking.js';

/** The states past the budget's comfort, in order of how bad they are. */
const RANK = { ok: 0, near: 1, over: 2 };

const numberOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * The share of a budget used: the larger of the token share and the cost
 * share (each only where its budget is above zero); null without a budget.
 * @param {{ used?: number|null, budget?: number|null, cost?: number|null, costBudget?: number|null }} values
 * @returns {number|null}
 */
export function shareOf(values = {}) {
  const shares = [];
  const used = numberOf(values.used);
  const budget = numberOf(values.budget);
  const cost = numberOf(values.cost);
  const costBudget = numberOf(values.costBudget);
  if (budget && used !== null) shares.push(used / budget);
  if (costBudget && cost !== null) shares.push(cost / costBudget);
  return shares.length ? Math.max(...shares) : null;
}

/**
 * Where a share stands: 'over' past 1, 'near' from `warn` (default 0.8),
 * else 'ok' (also without a share).
 * @param {number|null} share
 * @param {number} [warn]
 * @returns {'ok'|'near'|'over'}
 */
export function stateOf(share, warn = 0.8) {
  if (share === null || !Number.isFinite(share)) return 'ok';
  if (share > 1) return 'over';
  const limit = Number.isFinite(Number(warn)) && Number(warn) > 0 ? Number(warn) : 0.8;
  return share >= limit ? 'near' : 'ok';
}

/**
 * The token figures as they show: "182.4K tokens", or "182.4K of 250K
 * tokens" against a budget (string usageOf); '' without a count.
 * @param {number|null} used
 * @param {number|null} [budget]
 * @returns {string}
 */
export function usageText(used, budget = null) {
  const count = numberOf(used);
  if (count === null) return '';
  const limit = numberOf(budget);
  if (!limit) return tokensText(count);
  return t('usageOf', { used: number(count, { notation: 'compact', maximumFractionDigits: 1 }), budget: tokensText(limit) });
}

/**
 * The cost as it shows: "$3.12", or "$3.12 of $5.00" against a budget
 * (string usageOf); '' without a cost.
 * @param {number|null} cost
 * @param {number|null} [costBudget]
 * @param {string} [code] ISO 4217, default USD
 * @returns {string}
 */
export function costText(cost, costBudget = null, code = 'USD') {
  const value = numberOf(cost);
  if (value === null) return '';
  const limit = numberOf(costBudget);
  const unit = code || 'USD';
  return limit ? t('usageOf', { used: money(value, unit), budget: money(limit, unit) }) : money(value, unit);
}

function readAttributes(el) {
  return {
    used: numberOf(el.getAttribute('data-ds-usage-used')),
    budget: numberOf(el.getAttribute('data-ds-usage-budget')),
    cost: numberOf(el.getAttribute('data-ds-usage-cost')),
    costBudget: numberOf(el.getAttribute('data-ds-usage-cost-budget')),
    currency: el.getAttribute('data-ds-usage-currency') || 'USD',
    warn: numberOf(el.getAttribute('data-ds-usage-warn')) ?? 0.8,
  };
}

const KEYS = ['used', 'budget', 'cost', 'costBudget', 'currency', 'warn'];

function controller(el, start, signal) {
  const doc = el.ownerDocument;
  const listeners = new Set();
  const state = { ...start };
  let shown = null;

  const part = (name) => el.querySelector(`.ds-usage__${name}`);

  const snapshot = () => {
    const share = shareOf(state);
    return { used: state.used, budget: state.budget, cost: state.cost, costBudget: state.costBudget, currency: state.currency, share, state: stateOf(share, state.warn) };
  };

  const write = (node, text) => {
    if (node && node.textContent !== text) node.textContent = text;
  };

  const render = (speak) => {
    const now = snapshot();
    const meter = part('meter');
    // Without a budget there is no share: no meter at 0% for a screen reader, no empty track.
    if (meter) meter.hidden = now.share === null;
    if (meter && now.share === null) {
      for (const name of ['aria-valuenow', 'aria-valuetext', 'aria-valuemin', 'aria-valuemax']) meter.removeAttribute(name);
      meter.style.removeProperty('--ds-share');
      meter.classList.remove('ds-tone-warning', 'ds-tone-error');
    } else if (meter) {
      if (!meter.hasAttribute('role')) meter.setAttribute('role', 'meter');
      const shareShown = Math.min(1, now.share);
      meter.style.setProperty('--ds-share', String(shareShown));
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      // A meter's value stays in its range; the text says how far past it.
      meter.setAttribute('aria-valuenow', String(Math.round(shareShown * 100)));
      meter.setAttribute('aria-valuetext', t('usageShare', { percent: percent(now.share, { maximumFractionDigits: 0 }) }));
      meter.classList.toggle('ds-tone-warning', now.state === 'near');
      meter.classList.toggle('ds-tone-error', now.state === 'over');
    }
    write(part('value'), usageText(now.used, now.budget));
    write(part('cost'), costText(now.cost, now.costBudget, now.currency));
    if (now.state === 'ok') el.removeAttribute('data-state');
    else el.setAttribute('data-state', now.state);
    const status = part('status');
    if (status && shown !== now.state) {
      if (now.state === 'ok') status.replaceChildren();
      else {
        const word = doc.createElement('span');
        word.textContent = t(now.state === 'over' ? 'usageOver' : 'usageNear');
        status.replaceChildren(iconElement(now.state === 'over' ? alertCircle : alert, 16, 'ds-usage__icon', doc), word);
      }
      status.hidden = now.state === 'ok';
    }
    if (speak && shown !== null && RANK[now.state] > RANK[shown] && !signal?.aborted && el.getAttribute('data-ds-usage-announce') !== 'off') {
      announce(t(now.state === 'over' ? 'usageOver' : 'usageNear'));
    }
    shown = now.state;
    return now;
  };

  render(false);

  return {
    get: snapshot,
    set(changes = {}) {
      let changed = false;
      for (const key of KEYS) {
        if (!(key in changes)) continue;
        const value = key === 'currency' ? String(changes.currency || 'USD') : key === 'warn' ? numberOf(changes.warn) ?? 0.8 : numberOf(changes[key]);
        if (value !== state[key]) {
          state[key] = value;
          changed = true;
        }
      }
      if (!changed) return;
      const detail = render(true);
      if (signal?.aborted) return;
      emit(el, 'change', detail);
      listeners.forEach((fn) => fn(detail));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      Object.assign(state, readAttributes(el));
      render(true);
    },
    destroy() {
      listeners.clear();
    },
  };
}

define('usage', {
  attribute: 'data-ds-usage',
  attributes: ['data-ds-usage-used', 'data-ds-usage-budget', 'data-ds-usage-cost', 'data-ds-usage-cost-budget', 'data-ds-usage-currency', 'data-ds-usage-warn'],
  init(el, ctx) {
    const handle = controller(el, readAttributes(el), ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
});

/**
 * A usage meter driven from the page; the same controller the attribute
 * path makes.
 * @param {Element} el
 * @param {{ used?: number|null, budget?: number|null, cost?: number|null, costBudget?: number|null, currency?: string, warn?: number }} [options]
 */
export function create(el, options = {}) {
  return controller(el, {
    used: numberOf(options.used),
    budget: numberOf(options.budget),
    cost: numberOf(options.cost),
    costBudget: numberOf(options.costBudget),
    currency: options.currency || 'USD',
    warn: numberOf(options.warn) ?? 0.8,
  });
}
