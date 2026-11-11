/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.popover (js/popover.js). */
import type { CloseReason, OverlayController } from './overlay.js';

export interface PopoverOptions {
  /** The control that opened it: focus goes back there, `aria-expanded` follows (default: the focused element). */
  opener?: Element | null;
  /** Where it is placed: an element or a point in viewport coordinates (default: the opener). */
  anchor?: Element | { x: number; y: number } | null;
  /** The side of the anchor (default 'bottom'); flipped when it does not fit and the other side has more room. */
  placement?: 'bottom' | 'top' | 'start' | 'end';
  /** Along that side (default 'start', 'center' with an arrow). */
  align?: 'start' | 'center' | 'end';
  /** Moves focus in (default true); false for a toggletip or a hover card. */
  focus?: boolean;
  /** Where focus goes on close when the opener is gone. */
  returnTo?: () => Element | null | undefined;
}

/** Opens a popover placed at its anchor in the top layer, through DS.overlay.open(). */
export declare function open(element: Element, options?: PopoverOptions): Promise<void>;
/** Closes a popover: DS.overlay.close(). */
export declare function close(element: Element, options?: { reason?: CloseReason }): Promise<void>;
/** The controller of a popover, the one a [data-ds-popover] trigger makes. */
export declare function create(element: Element): OverlayController;
