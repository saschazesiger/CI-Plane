/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.toggletip (js/toggletip.js). */

/** The controller of a toggletip button, the one [data-ds-toggletip] makes. */
export interface ToggletipController {
  element: Element;
  /** Whether its card is open. */
  get(): boolean;
  /** Opens (and announces) or closes its card. */
  set(value: boolean): Promise<void>;
  /** Hears the card's ds:open and ds:close, or the button's ds:change; returns the unsubscribe. */
  on(type: string, fn: (event: Event) => void): () => void;
  destroy(): void;
}

/** The controller of a toggletip button. */
export declare function create(element: Element): ToggletipController;
