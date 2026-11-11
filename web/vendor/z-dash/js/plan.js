/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The plan card (DS.plan): a plan an assistant or agent proposes, its
 * steps, and the decision the person makes: approve or reject.
 *
 *   <section class="ds-plan" data-ds-plan aria-labelledby="plan-title"> ...
 *     <button class="ds-btn ds-btn--filled" type="button" data-ds-plan-action="approve">Approve</button>
 *     <button class="ds-btn" type="button" data-ds-plan-action="reject">Reject</button> ... </section>
 *   const plan = DS.plan.create(el);
 *   plan.on('change', ({ state }) => {});
 *   plan.set('approved');
 *
 * Attributes (DS.init(); a change is read again): data-ds-plan-state
 * (waiting, approved or rejected: a plan rendered from history; default
 * waiting) and, on its buttons, data-ds-plan-action="approve" or "reject".
 *
 * A press on an action asks first: ds:decide (cancelable, with
 * { decision }) bubbles from the card, and a page that calls
 * preventDefault() keeps it waiting (it decides later with set(), after
 * its own request). Otherwise the card takes the state, writes
 * data-state, the icon and the word of .ds-plan__state (strings
 * planWaiting, planApproved, planRejected), lets the .ds-plan__actions go
 * (DS.motion.leave(), focus moving to the title first), announces the
 * word and emits ds:change with { state }. Back to waiting, the actions
 * come back (DS.motion.enter()).
 *
 * The controller: get() ({ state }), set(state), on('change', fn),
 * update(), destroy().
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { enter, leave } from './motion.js';
import { announce } from './a11y.js';
import { checkCircle, circleX, hourglass, iconElement } from './icons.js';

/** The states of a plan, in their order. */
export const PLAN_STATES = Object.freeze(['waiting', 'approved', 'rejected']);

const GLYPHS = { waiting: hourglass, approved: checkCircle, rejected: circleX };
const WORDS = { waiting: 'planWaiting', approved: 'planApproved', rejected: 'planRejected' };
const DECISIONS = { approve: 'approved', reject: 'rejected' };

/**
 * A state as the card takes it: one of PLAN_STATES, 'waiting' for anything
 * else; the verbs approve and reject count as their states.
 * @param {string|null|undefined} value
 * @returns {'waiting'|'approved'|'rejected'}
 */
export function planState(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const state = DECISIONS[text] ?? text;
  return PLAN_STATES.includes(state) ? /** @type {'waiting'|'approved'|'rejected'} */ (state) : 'waiting';
}

function controller(el, start, given) {
  // Without the signal of DS.init() (create()), destroy() ends its own.
  const own = given ? null : new AbortController();
  const signal = given ?? own.signal;

  const doc = el.ownerDocument;
  const listeners = new Set();
  let state = planState(start);
  let rendered = null;

  el.querySelector('.ds-plan__icon')?.setAttribute('aria-hidden', 'true');

  const title = () => el.querySelector('.ds-plan__title');
  const actions = () => el.querySelector('.ds-plan__actions');

  const render = (moving) => {
    if (rendered === state) return;
    const before = rendered;
    rendered = state;
    el.setAttribute('data-state', state);
    const part = el.querySelector('.ds-plan__state');
    if (part) {
      const word = doc.createElement('span');
      word.textContent = t(WORDS[state]);
      part.replaceChildren(iconElement(GLYPHS[state], 16, 'ds-plan__glyph', doc), word);
    }
    const box = actions();
    if (!box) return;
    if (state === 'waiting') {
      if (moving && before !== null) enter(box);
      else box.hidden = false;
      return;
    }
    const heading = title();
    if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    if (moving) leave(box, '', { then: 'hide', focus: heading });
    else {
      if (heading && box.contains(doc.activeElement)) heading.focus();
      box.hidden = true;
    }
  };

  const change = (next, moving) => {
    const value = planState(next);
    if (value === state) return;
    state = value;
    render(moving);
    if (signal.aborted) return;
    if (moving && state !== 'waiting') announce(t(WORDS[state]));
    const detail = { state };
    emit(el, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  };

  el.addEventListener('click', (event) => {
    const button = /** @type {Element} */ (event.target)?.closest?.('[data-ds-plan-action]');
    if (!button || !el.contains(button) || button.closest('.ds-plan') !== el) return;
    const decision = DECISIONS[button.getAttribute('data-ds-plan-action')];
    if (!decision || state !== 'waiting') return;
    if (!emit(el, 'decide', { decision }, { cancelable: true })) return;
    change(decision, true);
  }, { signal });

  render(false);

  return {
    get: () => ({ state }),
    set(value) {
      change(value, true);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      change(el.getAttribute('data-ds-plan-state'), false);
    },
    destroy() {
      listeners.clear();
      own?.abort();
    },
  };
}

define('plan', {
  attribute: 'data-ds-plan',
  attributes: ['data-ds-plan-state'],
  init(el, ctx) {
    const handle = controller(el, el.getAttribute('data-ds-plan-state'), ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
});

/**
 * A plan card driven from the page; the same controller the attribute
 * path makes; destroy() removes its press listener.
 * @param {Element} el
 * @param {{ state?: 'waiting'|'approved'|'rejected' }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options.state ?? el.getAttribute('data-ds-plan-state'));
}
