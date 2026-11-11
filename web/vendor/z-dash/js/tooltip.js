/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Tooltips (DS.tooltip; DS.overlay.tooltips calls it).
 *
 * Tooltips (D17, WCAG 1.4.13): tooltips(root) serves every [data-tip]
 * trigger in root with one tooltip per call: shown after
 * --ds-delay-tooltip on hover (mouse and pen) and at once on keyboard
 * focus, at once again within --ds-delay-tooltip-skip of the last hide
 * (warm-up; a visible one swaps text and place in place; anchored, its
 * data-placement is read again two frames later), hoverable during
 * the --ds-delay-tooltip-hide grace, hidden by Escape (only then is the key
 * the tooltip's, unless an open layer lies over its trigger: then the same
 * Escape also closes that layer), by any pointerdown and by open(); the
 * opener of an open layer shows no tip. A tip that repeats the
 * trigger's visible text shows only while that text is cut off. On touch a
 * tap shows the tip of an image or a blocked control, a long press the
 * others. A trigger that leaves the document takes its tooltip with it.
 * On the trigger, data-tip-placement (bottom by default; top, start, end)
 * picks the side (flipped when it does not fit there and fits on the other
 * one) and data-tip-delay (none, short: --ds-delay-tooltip-skip, long: twice
 * --ds-delay-tooltip) the wait of a hover; data-tip-shortcut fills the
 * shortcut slot.
 * Like the snackbar regions, it is never made inert by the div trap or the
 * modal drawer, so a trigger inside one shows a hoverable tooltip that is
 * heard.
 *
 * The placement is js/position.js. DS.core.init() serves the tooltips of
 * every root it initialises.
 *
 * Progressive:
 * - CSS anchor positioning (js/position.js detects anchorName and
 *   position-area; the tooltip goes into the top layer as popover="manual",
 *   anchored to its trigger): without it the script places it
 *   (--ds-tooltip-x/-y, in the terms of the box it is fixed to).
 */
import { define } from './core.js';
import { motionDuration, originFrom, settled } from './motion.js';
import { claimAnchor, dropProbe, place as positionPlace, pxOf, releaseAnchor, supportsAnchoring } from './position.js';
import { internals } from './overlay.js';

const { tooltipControllers, neverInert, activeIn, sharedOf, own, disown, viewOf, flushStyle, watchModality, layerOver, opensOpenLayer, nextAnchorName, clock, normalText, nextFrame } = internals;

/* ── Tooltips ───────────────────────────────────────── */

let tooltipWarned = false;

/** A close enough accessible name: aria-labelledby, aria-label, else the text. */
function accessibleName(node) {
  const doc = node.ownerDocument;
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) return ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
  return node.getAttribute('aria-label') ?? node.textContent ?? '';
}

/** A tap on touch moves at most this far (px, a distance) between pointerdown and pointerup. */
const TAP_SLOP_PX = 10;

/** How many descendants of a trigger the cut-off check measures, at most. */
const CUT_DESCENDANTS = 24;

/** How many ancestors with the trigger's text the cut-off check measures (a td around a link), at most. */
const CUT_ANCESTORS = 3;

/**
 * The text a trigger shows, normalised like normalText(): its text nodes
 * that render (their parent has client rects), skipping .ds-sr,
 * [aria-hidden="true"], svg, and any element whose border box is at most
 * 1×1px (the .ds-sr declarations without the class: a collapsed adaptive
 * button's label, a rail's drawer label).
 */
function visibleText(trigger) {
  const doc = trigger.ownerDocument;
  const verdicts = new Map();
  const hidden = (element) => {
    for (let at = element; at && at !== trigger.parentElement; at = at.parentElement) {
      if (verdicts.has(at)) return verdicts.get(at);
      const box = at.getBoundingClientRect?.();
      const gone = at.matches('.ds-sr, [aria-hidden="true"], svg, svg *') || !at.getClientRects?.().length || (box && box.width <= 1 && box.height <= 1);
      if (gone) {
        verdicts.set(at, true);
        return true;
      }
      if (at === trigger) break;
    }
    verdicts.set(element, false);
    return false;
  };
  const walker = doc.createTreeWalker(trigger, 4);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && node.nodeValue?.trim() && !hidden(parent)) parts.push(node.nodeValue);
  }
  return normalText(parts.join(' '));
}

/** Whether a box clips its content: overflow other than visible and more content than room. */
function clips(element) {
  const style = viewOf(element).getComputedStyle?.(element);
  if (!style || (style.overflowX === 'visible' && style.overflowY === 'visible')) return false;
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

/**
 * Whether the tooltip of `trigger` is wanted now. A tip with a shortcut or
 * one that differs from the text the trigger shows always is (an icon button,
 * a label hidden on phones, a collapsed rail); a tip that repeats it only while that text is
 * cut off: the trigger, one of its first descendants or one of the
 * ancestors that hold just its text (a td around a link) clips it.
 * @returns {'adds'|'cut'|null} why it shows (a cut-off text is never a description), or null: not now
 */
function tipWanted(trigger) {
  const tip = normalText(trigger.getAttribute('data-tip'));
  if (!tip) return null;
  // A shortcut adds what the trigger does not show, whatever the text.
  if (normalText(trigger.getAttribute('data-tip-shortcut'))) return 'adds';
  const text = visibleText(trigger);
  if (text !== tip) return 'adds';
  if (clips(trigger)) return 'cut';
  const descendants = trigger.querySelectorAll('*');
  for (let index = 0; index < descendants.length && index < CUT_DESCENDANTS; index += 1) if (clips(descendants[index])) return 'cut';
  let at = trigger.parentElement;
  for (let step = 0; at && step < CUT_ANCESTORS && normalText(at.textContent) === text; step += 1, at = at.parentElement) {
    if (clips(at)) return 'cut';
  }
  return null;
}

/** The sides a trigger may ask for (data-tip-placement). */
const SIDES = new Set(['bottom', 'top', 'start', 'end']);

/** The side the tooltip of `trigger` goes on: data-tip-placement, below by default. */
function sideOf(trigger) {
  const side = trigger.getAttribute('data-tip-placement') ?? '';
  return SIDES.has(side) ? side : 'bottom';
}

function focusVisible(node) {
  try {
    return node.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Tooltips for every [data-tip] trigger inside `root` (the attribute holds
 * the text), through one set of delegated listeners and one
 * <div class="ds-tooltip" role="tooltip"> that it creates inside the
 * .ds-theme around `root` (warns once if there is none). A mouse or pen
 * that rests on a trigger shows it after --ds-delay-tooltip; keyboard
 * focus (:focus-visible) shows it at once. On touch a tap on an image
 * ([role="img"]) or a blocked control ([aria-disabled="true"]) shows it at
 * once and a second tap hides it; a long press of --ds-delay-tooltip on any
 * other trigger but a link shows it and swallows the click and the context
 * menu that follow; it stays until the next pointerdown, a scroll or
 * Escape (no timeout: WCAG 1.4.13).
 * A tip that repeats the text the trigger shows shows only while that
 * text is cut off (tipWanted()), and never describes it.
 * While one shows, or within --ds-delay-tooltip-skip of the last hide, the
 * next trigger shows at once: a visible tooltip swaps text and place in
 * place, a hidden one only fades in (data-warm). It hides after the
 * --ds-delay-tooltip-hide grace, which the pointer may use to move onto
 * it; at once on Escape (the key is then the tooltip's: the dialog under
 * it stays open), on any pointerdown, on DS.overlay.open(), when its
 * trigger scrolls out of view, and when its trigger leaves the document
 * (a MutationObserver on the root, connected only while it shows). While
 * shown, the trigger is described by it (aria-describedby), unless its
 * accessible name says the same.
 * Placement: below the trigger, above it without room; with popover and
 * anchor positioning in the top layer, else by --ds-tooltip-x/-y. A second
 * call on the same root returns the first handle (also one of another
 * copy of ds.js), and a trigger inside nested roots (a host page's
 * document and an embedded widget's root) is served by the innermost one.
 * An open shadow root works as a root too (the tooltip goes into the
 * .ds-theme inside it).
 * @param {Document|Element|ShadowRoot} [root]
 * @returns {{ destroy: () => void }}
 */
export function tooltips(root = globalThis.document) {
  const doc = root?.nodeType === 9 ? /** @type {Document} */ (root) : root?.ownerDocument;
  if (!doc) return { destroy() {} };
  const view = doc.defaultView ?? globalThis;
  // A shadow root stays itself: its listeners see the real targets (the
  // document sees the host), and its theme is the .ds-theme inside it,
  // where ds.css applies.
  const shadow = root.nodeType === 11;
  const rootElement = root.nodeType === 9 ? doc.documentElement : /** @type {Element} */ (root);
  // One controller per root (whichever copy of ds.js made it): a second call returns the first.
  const roots = sharedOf(doc).tipRoots;
  const existing = roots.get(rootElement);
  if (existing) return existing;
  watchModality(doc);
  const theme = shadow ? /** @type {ShadowRoot} */ (root).querySelector('.ds-theme')
    : rootElement.closest('.ds-theme') ?? (root.nodeType === 9 ? doc.querySelector('.ds-theme') : null);
  if (!theme && !tooltipWarned) {
    tooltipWarned = true;
    view.console?.warn('Z-Dash: DS.overlay.tooltips() on a root outside .ds-theme. The tooltip must sit inside the .ds-theme element, or it gets neither the tokens nor the motion.');
  }
  const anchored = supportsAnchoring(view);
  const home = !theme || theme === doc.documentElement ? doc.body : theme;

  const tip = doc.createElement('div');
  tip.className = 'ds-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.id = `ds-tooltip-${sharedOf(doc).seq += 1}`;
  tip.hidden = true;
  tip.setAttribute('data-state', 'closed');
  if (anchored) {
    tip.setAttribute('popover', 'manual');
    tip.setAttribute('data-anchored', '');
  }
  neverInert.add(tip);
  // A runtime node: a re-render of the theme (DS.dom.morphHtml) keeps it.
  tip.setAttribute('data-ds-keep', '');
  home.append(tip);

  /** @type {'hidden'|'open'|'closing'} */
  let phase = 'hidden';
  let trigger = /** @type {Element|null} */ (null);
  let hovering = false;
  let focusing = false;
  let showTimer = /** @type {any} */ (0);
  let hideTimer = /** @type {any} */ (0);
  let lastHide = -Infinity;
  let run = 0;
  let frame = 0;
  let ownAnchor = /** @type {HTMLElement|null} */ (null);
  let described = /** @type {Element|null} */ (null);
  // Touch: the press under way, whether the tooltip on screen came from
  // touch, and the listener that swallows what a long press ends in.
  let press = /** @type {{ trigger: Element, id: number, x: number, y: number, timer: any } | null} */ (null);
  let touchShown = false;
  let swallow = /** @type {((event: Event) => void) | null} */ (null);
  // The trigger leaving the document hides the tooltip at once (connected while it shows).
  const Observer = view.MutationObserver;
  const watcher = typeof Observer === 'function' ? new Observer(() => {
    if (phase !== 'hidden' && trigger && !trigger.isConnected) hideNow();
  }) : null;
  let watching = false;

  const time = (token) => motionDuration(tip.isConnected ? tip : shadow ? theme ?? /** @type {ShadowRoot} */ (root).host : rootElement, token);

  /**
   * How long a mouse or pen rests on `trigger` before its tip shows
   * (data-tip-delay): none at once, short --ds-delay-tooltip-skip, long twice
   * --ds-delay-tooltip, else --ds-delay-tooltip.
   */
  function delayOf(trigger) {
    const delay = trigger.getAttribute('data-tip-delay');
    if (delay === 'none') return 0;
    if (delay === 'short') return time('--ds-delay-tooltip-skip');
    if (delay === 'long') return 2 * time('--ds-delay-tooltip');
    return time('--ds-delay-tooltip');
  }
  const contains = (node) => (root.nodeType === 9 ? doc.contains(node) : rootElement.contains(node));

  /** Where the tooltip lives for a trigger: its overlay (in the top layer, never inert), else the theme. */
  function hostFor(node) {
    return node.closest('dialog[open], .ds-dialog:not(.ds-dialog--contained), .ds-sheet') ?? home;
  }

  /** Points the tooltip at `next`, through a name shared with a popup anchored there (claimAnchor). */
  function anchorTo(next) {
    if (!anchored || (ownAnchor && ownAnchor === next)) return;
    unanchor();
    const { name, mine } = claimAnchor(next, () => nextAnchorName(doc));
    if (mine) ownAnchor = /** @type {HTMLElement} */ (next);
    tip.style.setProperty('position-anchor', name);
  }

  function unanchor() {
    releaseAnchor(ownAnchor);
    ownAnchor = null;
  }

  /** Marks the side the engine put an anchored tooltip on; true when that changed. */
  function readSide(next) {
    const box = tip.getBoundingClientRect();
    const anchor = next.getBoundingClientRect();
    const rtl = view.getComputedStyle?.(next).direction === 'rtl';
    let side = 'bottom';
    if (box.bottom <= anchor.top + 1) side = 'top';
    else if (box.right <= anchor.left + 1) side = rtl ? 'end' : 'start';
    else if (box.left >= anchor.right - 1) side = rtl ? 'start' : 'end';
    if (side === (tip.getAttribute('data-placement') ?? 'bottom')) return false;
    if (side === 'bottom') tip.removeAttribute('data-placement');
    else tip.setAttribute('data-placement', side);
    return true;
  }

  /**
   * On the side its trigger asks for (data-tip-placement; below by default),
   * centred and clamped to the viewport; on the other side when it does not
   * fit there and fits there.
   */
  function place(next) {
    const side = sideOf(next);
    if (side === 'bottom') tip.removeAttribute('data-side');
    else tip.setAttribute('data-side', side);
    if (anchored) {
      // The engine places it; its side sets the origin. Chromium lays a
      // swap out with what it took from the previous anchor at the last
      // rendering (the scroll offset of a box around it: from a trigger in
      // a scrolled box it read "top" for a tooltip that then sits below),
      // so the side read now is a guess, read again once two frames have
      // rendered; the origin follows a corrected side.
      readSide(next);
      const mine = run;
      nextFrame(doc, () => nextFrame(doc, () => {
        if (mine !== run || phase !== 'open' || trigger !== next || !tip.isConnected) return;
        if (readSide(next)) originFrom(next, tip);
      }));
      return;
    }
    const gap = pxOf(tip, '--ds-space-2', 8);
    positionPlace(tip, next, { side, align: 'center', offset: gap, padding: gap, flip: 'fits', size: false, x: '--ds-tooltip-x', y: '--ds-tooltip-y' });
  }

  function describe(next, why) {
    undescribe();
    // A cut-off text read again adds nothing.
    if (why === 'cut' || normalText(tip.textContent) === normalText(accessibleName(next))) return;
    const ids = (next.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!ids.includes(tip.id)) next.setAttribute('aria-describedby', [...ids, tip.id].join(' '));
    own(next, 'attrs', 'aria-describedby');
    described = next;
  }

  function undescribe() {
    if (!described) return;
    const ids = (described.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== tip.id);
    if (ids.length) described.setAttribute('aria-describedby', ids.join(' '));
    else described.removeAttribute('aria-describedby');
    disown(described, 'attrs', 'aria-describedby');
    described = null;
  }

  function cancelTimers() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
  }

  /** Shows the tooltip of `next` now (if it is wanted now): in place when one is visible, else from its closed state. */
  function show(next, touch = false) {
    cancelTimers();
    const text = next.getAttribute('data-tip') ?? '';
    // The opener of an open menu (or dialog) shows no tip: it would cover
    // the layer or take the Escape that closes it.
    const why = next.isConnected && !opensOpenLayer(next) ? tipWanted(next) : null;
    if (!text.trim() || !why) return;
    touchShown = touch;
    if (watcher && !watching) {
      watcher.observe(shadow ? /** @type {ShadowRoot} */ (root) : rootElement, { childList: true, subtree: true });
      watching = true;
    }
    const host = hostFor(next);
    const visible = phase !== 'hidden' && tip.parentNode === host;
    const warm = !visible && clock() - lastHide < time('--ds-delay-tooltip-skip');
    run += 1;
    trigger = next;
    focusing = next === activeIn(next) && focusVisible(next);
    tip.textContent = text;
    const shortcut = next.getAttribute('data-tip-shortcut');
    if (shortcut) {
      const slot = doc.createElement('span');
      slot.className = 'ds-tooltip__shortcut';
      slot.textContent = shortcut;
      tip.append(slot);
    }
    if (visible) {
      // A swap (or a hide taken back): text and place change where it is,
      // and a fade still under way turns back from its current opacity.
      anchorTo(next);
      place(next);
      originFrom(next, tip);
      tip.setAttribute('data-state', 'open');
    } else {
      if (tip.parentNode !== host) {
        try {
          if (anchored && tip.matches(':popover-open')) tip.hidePopover();
        } catch {
          // Not open after all.
        }
        host.append(tip);
      }
      // The closed state at rest size (data-warm), so its place and the
      // origin at the anchor side are measured true.
      tip.setAttribute('data-state', 'closed');
      tip.setAttribute('data-warm', '');
      tip.hidden = false;
      anchorTo(next);
      if (anchored) {
        try {
          tip.showPopover();
        } catch {
          // Already open (a fade that just ended): it stays.
        }
      }
      place(next);
      originFrom(next, tip);
      // The closed state is styled without transitions: cold, from --ds-scale-tooltip at the anchor; warm, at rest
      // size, so only the opacity moves (Firefox otherwise starts the scale from where the last exit left it).
      tip.style.transition = 'none';
      if (!warm) tip.removeAttribute('data-warm');
      flushStyle(tip);
      tip.style.removeProperty('transition');
      tip.setAttribute('data-state', 'open');
    }
    phase = 'open';
    describe(next, why);
  }

  function unwatch() {
    if (!watching) return;
    watcher?.disconnect();
    watching = false;
  }

  /** The end of an exit: hidden, out of the top layer, unanchored. */
  function rest() {
    phase = 'hidden';
    trigger = null;
    touchShown = false;
    try {
      if (anchored && tip.matches(':popover-open')) tip.hidePopover();
    } catch {
      // Not open.
    }
    tip.hidden = true;
    unanchor();
    dropProbe(tip);
  }

  /** Starts the exit: a quick fade; once it settled the tooltip is hidden. */
  function hide() {
    cancelTimers();
    if (phase !== 'open') return;
    phase = 'closing';
    lastHide = clock();
    undescribe();
    unwatch();
    const mine = ++run;
    tip.setAttribute('data-state', 'closed');
    settled(tip, { transitions: true }).then(() => {
      if (mine !== run || phase !== 'closing') return;
      rest();
    });
  }

  /**
   * Its trigger left the document: hidden at once, without the fade (an
   * anchor that is gone would put it in a corner of the viewport, or leave
   * it at the old place).
   */
  function hideNow() {
    cancelTimers();
    if (phase === 'hidden') return;
    if (phase === 'open') lastHide = clock();
    undescribe();
    unwatch();
    run += 1;
    hovering = false;
    focusing = false;
    tip.style.transition = 'none';
    tip.setAttribute('data-state', 'closed');
    flushStyle(tip);
    tip.style.removeProperty('transition');
    rest();
  }

  /** Hides after the grace, unless the pointer or keyboard focus still holds it. */
  function hideLater() {
    clearTimeout(showTimer);
    showTimer = 0;
    if (hovering || focusing || phase !== 'open' || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (!hovering && !focusing) hide();
    }, time('--ds-delay-tooltip-hide'));
  }

  /** The trigger of `node` that this controller serves: inside nested roots, the innermost one serves it. */
  const triggerOf = (node) => {
    const found = /** @type {Element|null} */ (node?.closest?.('[data-tip]') ?? null);
    if (!found || !contains(found)) return null;
    for (let at = /** @type {Element|null} */ (found); at; at = at.parentElement) {
      if (roots.has(at)) return at === rootElement ? found : null;
    }
    return found;
  };

  function onPointerOver(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch') return;
    const next = triggerOf(event.target);
    if (!next || next.contains(/** @type {Node} */ (event.relatedTarget))) return;
    // A tip that repeats a text that fits is not wanted: the pointer rests on nothing.
    if (!tipWanted(next)) return;
    hovering = true;
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (phase === 'open' && trigger === next) return;
    if (phase !== 'hidden' || clock() - lastHide < time('--ds-delay-tooltip-skip')) {
      show(next);
      return;
    }
    clearTimeout(showTimer);
    const wait = delayOf(next);
    if (wait <= 0) {
      show(next);
      return;
    }
    showTimer = setTimeout(() => {
      showTimer = 0;
      show(next);
    }, wait);
  }

  function onPointerOut(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch') return;
    const from = triggerOf(event.target);
    const to = /** @type {Node} */ (event.relatedTarget);
    if (!from || from.contains(to) || tip.contains(to)) return;
    hovering = false;
    hideLater();
  }

  function onTipOver(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch' || phase !== 'open') return;
    // Hoverable: the pointer crossed onto the tooltip within the grace.
    hovering = true;
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function onTipOut(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch') return;
    const to = /** @type {Node} */ (event.relatedTarget);
    if (tip.contains(to) || trigger?.contains(to)) return;
    hovering = false;
    hideLater();
  }

  function onFocusIn(/** @type {FocusEvent} */ event) {
    const next = triggerOf(event.target);
    if (!next || !focusVisible(next) || !tipWanted(next)) return;
    hovering = false;
    show(next);
  }

  function onFocusOut(/** @type {FocusEvent} */ event) {
    const from = triggerOf(event.target);
    if (!from || from !== trigger || from.contains(/** @type {Node} */ (event.relatedTarget))) return;
    focusing = false;
    // A focusin on another trigger right after takes over in place.
    hideLater();
  }

  function onKeyDown(/** @type {KeyboardEvent} */ event) {
    if (event.key !== 'Escape' || event.defaultPrevented || !escape()) return;
    event.preventDefault();
    event.stopPropagation();
  }

  /** The element a pointer event began on, also inside an open shadow root. */
  const origin = (/** @type {Event} */ event) => /** @type {Element} */ (event.composedPath?.()[0] ?? event.target);

  /** On touch a tap shows the tip of an image or a blocked control; the others need a long press. */
  const tapShows = (node) => node.matches('[role="img"], [aria-disabled="true"]');

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  function unswallow() {
    if (!swallow) return;
    doc.removeEventListener('click', swallow, true);
    doc.removeEventListener('contextmenu', swallow, true);
    swallow = null;
  }

  /** A long press showed a tooltip: the click (and a context menu) it would end in never happen. */
  function swallowNext() {
    unswallow();
    swallow = (/** @type {Event} */ event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') unswallow();
    };
    doc.addEventListener('click', swallow, true);
    doc.addEventListener('contextmenu', swallow, true);
  }

  function onPointerDown(/** @type {PointerEvent} */ event) {
    clearTimeout(showTimer);
    showTimer = 0;
    unswallow();
    cancelPress();
    const next = event.pointerType === 'touch' ? triggerOf(origin(event)) : null;
    // The second tap on a trigger whose tip touch showed only hides it.
    const hidesOwn = Boolean(next) && phase === 'open' && touchShown && trigger === next;
    hide();
    if (!next || hidesOwn) return;
    press = { trigger: next, id: event.pointerId, x: event.clientX, y: event.clientY, timer: 0 };
    if (tapShows(next) || next.matches('a[href]')) return;
    // A long press: shown once the press held --ds-delay-tooltip (a link keeps its own long press).
    press.timer = setTimeout(() => {
      if (!press || press.trigger !== next) return;
      press = null;
      show(next, true);
      if (phase === 'open' && trigger === next) swallowNext();
    }, time('--ds-delay-tooltip'));
  }

  function onPointerMove(/** @type {PointerEvent} */ event) {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) cancelPress();
  }

  function onPointerUp(/** @type {PointerEvent} */ event) {
    if (!press || event.pointerId !== press.id) return;
    const next = press.trigger;
    const near = Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_SLOP_PX;
    cancelPress();
    if (near && tapShows(next) && triggerOf(origin(event)) === next) show(next, true);
  }

  function onScroll() {
    // A tip that touch showed goes with any scroll.
    if (phase === 'open' && touchShown) {
      hide();
      return;
    }
    if (phase !== 'open' || frame) return;
    const update = () => {
      frame = 0;
      if (phase !== 'open' || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gone = !trigger.isConnected || rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth;
      if (gone) hide();
      else if (!anchored) place(trigger);
    };
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(update) : 0;
    if (!frame) update();
  }

  /**
   * Escape: hides a visible tooltip and reports whether the key was its.
   * It is not when an open layer lies over the trigger (a menu over its
   * opener's tip): the tooltip hides and the same Escape closes the layer.
   */
  function escape() {
    if (phase !== 'open') return false;
    const under = Boolean(trigger?.isConnected && layerOver(trigger));
    hovering = false;
    focusing = false;
    hide();
    return !under;
  }

  const controller = {
    hide() {
      clearTimeout(showTimer);
      showTimer = 0;
      hide();
    },
    escape,
  };
  tooltipControllers.add(controller);

  const target = /** @type {EventTarget} */ (root);
  target.addEventListener('pointerover', onPointerOver);
  target.addEventListener('pointerout', onPointerOut);
  target.addEventListener('focusin', onFocusIn);
  target.addEventListener('focusout', onFocusOut);
  tip.addEventListener('pointerover', onTipOver);
  tip.addEventListener('pointerout', onTipOut);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', cancelPress, true);
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  view.addEventListener('resize', onScroll);

  const handle = {
    destroy() {
      if (roots.get(rootElement) === handle) roots.delete(rootElement);
      tooltipControllers.delete(controller);
      cancelTimers();
      if (frame && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      target.removeEventListener('pointerover', onPointerOver);
      target.removeEventListener('pointerout', onPointerOut);
      target.removeEventListener('focusin', onFocusIn);
      target.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointermove', onPointerMove, { capture: true });
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', cancelPress, true);
      doc.removeEventListener('scroll', onScroll, { capture: true });
      view.removeEventListener('resize', onScroll);
      cancelPress();
      unswallow();
      unwatch();
      undescribe();
      unanchor();
      dropProbe(tip);
      run += 1;
      phase = 'hidden';
      tip.remove();
    },
  };
  roots.set(rootElement, handle);
  return handle;
}

/* DS.core.init() serves the tooltips of every root it initialises; a root served before keeps its own handle. */
define('tooltips', {
  global(root) {
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const existed = Boolean(doc) && sharedOf(doc).tipRoots.has(root.nodeType === 9 ? doc.documentElement : root);
    const handle = tooltips(root);
    return existed ? () => {} : () => handle.destroy();
  },
});

internals.use('tooltip', { tooltips });
