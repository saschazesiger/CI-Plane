/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Steps (DS.steps): where the user is in a sequence, and steps the user
 * can go to.
 *
 *   <ol class="ds-steps" aria-label="Report a problem" data-ds-steps>
 *     <li class="ds-steps__step" data-status="done"><button class="ds-steps__link" type="button"><span class="ds-steps__mark">(check)</span><span class="ds-steps__label">Device</span></button></li>
 *     <li class="ds-steps__step"><button class="ds-steps__link" type="button" aria-current="step"> ... </button></li>
 *     <li class="ds-steps__step"><span class="ds-steps__mark">3</span><span class="ds-steps__label">Contact</span></li>
 *   </ol>
 *   const steps = DS.steps.create(list);
 *   steps.get();  steps.set(2);  steps.on('change', ({ index, previous }) => ...);
 *
 * The current step: aria-current="step" on its .ds-steps__link, or on the
 * step itself when it has none (owned state). set(index) moves it, and a
 * screen reader hears "Step 2 of 4: Problem" (the string stepOf). The page
 * keeps data-status (done, error, optional): what a step is, it knows.
 *
 * A .ds-steps__link button of another step than the current one sends
 * ds:change ({ index, step, previous }) on the list; unless a listener cancels it (a step that must validate first),
 * that step becomes the current one and its link keeps the focus. A link
 * with an address (<a href>) navigates as links do: ds:change tells, the
 * next page marks its own step. aria-disabled links do nothing.
 *
 * ES2022. Progressive: none.
 */
import { define, emit, t } from './core.js';
import { own, disown } from './dom.js';
import { announce } from './a11y.js';

/**
 * The 1-based position and the label a step announces.
 * @param {number} index  0-based
 * @param {number} total
 * @param {string} label
 * @returns {{ position: number, total: number, label: string }}
 */
export function position(index, total, label) {
  const at = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, total - 1));
  return { position: total ? at + 1 : 0, total, label: label.trim() };
}

/** The steps of a list, not those of a list nested in one. */
function stepsOf(list) {
  return [...list.children].filter((child) => child.classList.contains('ds-steps__step'));
}

/** The text of a step's label, without the words read only to a screen reader. */
function labelOf(step) {
  const label = step.querySelector('.ds-steps__label');
  if (!label) return '';
  const copy = label.cloneNode(true);
  for (const part of copy.querySelectorAll('.ds-sr')) part.remove();
  return copy.textContent.trim();
}

/** What carries aria-current for a step: its link, else the step. */
function carrier(step) {
  return step.querySelector(':scope > .ds-steps__link') ?? step;
}

/**
 * The controller of one list.
 * @param {HTMLElement} list
 * @param {AbortSignal} [signal]
 */
function controller(list, signal) {
  const abort = new AbortController();
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const listeners = new Set();
  const owned = new Set();
  const take = (element) => {
    if (owned.has(element)) return;
    own(element, 'attrs', 'aria-current');
    owned.add(element);
  };

  const current = () => stepsOf(list).findIndex((step) => {
    const value = carrier(step).getAttribute('aria-current') ?? step.getAttribute('aria-current');
    return value !== null && value !== 'false';
  });

  /**
   * Makes the step at `index` the current one; returns whether it changed.
   * @param {number} index
   * @param {{ announce?: boolean }} [how]
   */
  const select = (index, how = {}) => {
    const steps = stepsOf(list);
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) return false;
    const previous = current();
    if (previous === index) return false;
    steps.forEach((step, at) => {
      for (const element of new Set([step, carrier(step)])) {
        take(element);
        if (at === index && element === carrier(step)) element.setAttribute('aria-current', 'step');
        else element.removeAttribute('aria-current');
      }
    });
    if (how.announce !== false) {
      const at = position(index, steps.length, labelOf(steps[index]));
      announce(t('stepOf', { step: at.position, total: at.total, label: at.label }));
    }
    for (const entry of listeners) entry({ index, step: steps[index], previous });
    return true;
  };

  list.addEventListener('click', (event) => {
    const link = /** @type {Element} */ (event.target)?.closest?.('.ds-steps__link');
    if (!link || !list.contains(link) || link.getAttribute('aria-disabled') === 'true') return;
    const step = link.closest('.ds-steps__step');
    const steps = stepsOf(list);
    const index = steps.indexOf(step);
    if (index < 0) return;
    const previous = current();
    if (index === previous) return;
    const navigates = link.tagName === 'A' && link.hasAttribute('href');
    const go = emit(list, 'change', { index, step, previous }, { cancelable: !navigates });
    if (navigates || !go) return;
    select(index);
  }, { signal: abort.signal });

  let gone = false;
  return {
    /** The 0-based index of the current step, or -1. */
    get() {
      return current();
    },
    /** Makes a step (its 0-based index) the current one and says so to a screen reader. */
    set(value) {
      return select(Number(value));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      if (gone) return;
      gone = true;
      abort.abort();
      listeners.clear();
      for (const element of owned) disown(element, 'attrs', 'aria-current');
      owned.clear();
    },
  };
}

define('steps', {
  attribute: 'data-ds-steps',
  init(el, ctx) {
    return controller(/** @type {HTMLElement} */ (el), ctx.signal);
  },
});

/**
 * A list of steps driven from the page; the same controller the attribute
 * path makes.
 * @param {HTMLElement} el  the .ds-steps list
 */
export function create(el) {
  return controller(el);
}
