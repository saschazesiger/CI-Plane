/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Toggletips (DS.toggletip): the info button "i" that opens a help card on a
 * click or a tap (never on hover), keeps focus on itself and says the card's
 * text to a screen reader. The card is a .ds-popover--tip that DS.popover
 * places and DS.overlay closes (Escape, a press outside, focus that leaves
 * button and card, a second click).
 *
 *   <button class="ds-toggletip" type="button" aria-label="About the serial number" aria-expanded="false"
 *           aria-controls="serial-help" data-ds-toggletip="#serial-help">(info)</button>
 *   <div class="ds-popover ds-popover--tip ds-popover--arrow" id="serial-help" role="group" aria-label="Serial number" hidden>…</div>
 *
 *   DS.toggletip.create(button)   // get(), set(), on(), destroy()
 *
 * data-ds-toggletip names the card (a selector or an id); empty, the card is
 * the button's next sibling .ds-popover. data-ds-toggletip-placement picks
 * its side (bottom by default; top, start, end). The card follows the button
 * in the markup, so Tab goes from the button to its link. A button without a
 * name gets the system's string moreInfo.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { announce } from './a11y.js';
import { internals } from './overlay.js';
import { open as openPopover, close as closePopover } from './popover.js';

const { overlays } = internals;

/** The card of a toggletip: the element its attribute names, else its next sibling popover. */
function cardOf(button) {
  const value = button.getAttribute('data-ds-toggletip') ?? '';
  if (value) {
    const scope = button.getRootNode?.() ?? button.ownerDocument;
    let found = null;
    try {
      found = scope.querySelector(value);
    } catch {
      // No selector: an id.
    }
    return found ?? scope.getElementById?.(value) ?? null;
  }
  const next = button.nextElementSibling;
  return next?.matches('.ds-popover') ? next : null;
}

/** What the card says, as one line: its title and text, its link names after them. */
function spoken(card) {
  return (card.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const isMine = (button, card) => overlays.get(card)?.phase === 'open' && overlays.get(card)?.opener === button;

/**
 * Opens or closes the card of `button`; open, it says the card's text.
 * @param {Element} button
 * @param {boolean} value
 * @returns {Promise<void>}
 */
function toggle(button, value) {
  const card = cardOf(button);
  if (!card) return Promise.resolve();
  if (!value) return isMine(button, card) ? closePopover(card, { reason: 'close' }) : Promise.resolve();
  if (isMine(button, card)) return Promise.resolve();
  const placement = button.getAttribute('data-ds-toggletip-placement') ?? undefined;
  const shown = openPopover(card, { opener: button, placement: /** @type {any} */ (placement), focus: false });
  announce(spoken(card));
  emit(button, 'change', { open: true, card });
  return shown;
}

/**
 * The controller of a toggletip button: get() says whether its card is open,
 * set(true | false) opens or closes it, on('open' | 'close', fn) hears the
 * card's ds: events and returns the unsubscribe; the button's own ds:change
 * ({ open, card }) tells that it opened.
 * @param {Element} element
 * @returns {{ element: Element, get: () => boolean, set: (value: boolean) => Promise<void>, on: (type: string, fn: (event: Event) => void) => () => void, destroy: () => void }}
 */
export function create(element) {
  const listeners = /** @type {Array<() => void>} */ ([]);
  if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !element.textContent?.trim()) {
    element.setAttribute('aria-label', t('moreInfo'));
  }
  return {
    element,
    get: () => {
      const card = cardOf(element);
      return Boolean(card) && isMine(element, card);
    },
    set: (value) => toggle(element, Boolean(value)),
    on(type, fn) {
      const name = `ds:${type}`;
      const card = cardOf(element);
      const target = type === 'change' || !card ? element : card;
      target.addEventListener(name, fn);
      const off = () => target.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      for (const off of listeners.splice(0)) off();
    },
  };
}

define('toggletip', {
  attribute: 'data-ds-toggletip',
  attributes: ['data-ds-toggletip-placement'],
  init(button, ctx) {
    const controller = create(button);
    button.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      // The second click of a double click toggles nothing.
      if (event.defaultPrevented || event.detail > 1) return;
      controller.set(!controller.get());
    }, { signal: ctx.signal ?? undefined });
    return controller;
  },
});
