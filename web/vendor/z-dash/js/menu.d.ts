/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.menu (js/menu.js). */
import type { CloseReason, OpenOptions, OverlayController } from './overlay.js';

/** Opens a menu: DS.overlay.open(). */
export declare function open(element: Element, options?: OpenOptions): Promise<void>;
/** Closes a menu: DS.overlay.close(). */
export declare function close(element: Element, options?: { reason?: CloseReason }): Promise<void>;
/** The controller of a menu, the one [data-ds-menu] makes. */
export declare function create(element: Element): OverlayController;
/** Opens a menu at a point (a context menu), or under the opener without one. */
export declare function openAt(element: Element, options?: { x?: number; y?: number; opener?: Element | null; returnTo?: () => Element | null | undefined }): Promise<void>;
