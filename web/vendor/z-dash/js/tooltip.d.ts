/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.tooltip (js/tooltip.js); DS.overlay.tooltips calls it. */
import type { Destroyable } from './motion.js';

/** Tooltips for every [data-tip] trigger under `root`. */
export declare function tooltips(root?: Document | Element | ShadowRoot): Destroyable;
