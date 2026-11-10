/**
 * Types of the classic script ds.js: the global DS and the registry
 * DashboardStyle.versions. Hand-written, like the module types next to
 * each module in js/*.d.ts (an import of js/<module>.js finds them by
 * itself). In a project with TypeScript or checkJs, reference this file:
 *
 *   /// <reference path="vendor/dashboard-style/ds.d.ts" />
 *
 * test/build.test.js keeps every declared export and its parameters equal
 * to the built modules.
 */
import type * as motion from './js/motion.js';
import type * as indicator from './js/indicator.js';
import type * as dom from './js/dom.js';
import type * as ripple from './js/ripple.js';
import type * as icons from './js/icons.js';
import type * as overlay from './js/overlay.js';

/** What window.DS holds: the version and one namespace per module. */
export interface DashboardStyleApi {
  /** The version of this copy (package.json at build time). */
  readonly version: string;
  readonly motion: typeof motion;
  readonly indicator: typeof indicator;
  readonly dom: typeof dom;
  readonly ripple: typeof ripple;
  readonly icons: typeof icons;
  readonly overlay: typeof overlay;
}

/** Every copy of ds.js on the page, by version: a widget reads DashboardStyle.versions['<its version>'] || DS. */
export interface DashboardStyleRegistry {
  versions: Record<string, DashboardStyleApi>;
}

declare global {
  /** The first copy of ds.js on the page (a second copy of another version leaves it alone). */
  var DS: DashboardStyleApi;
  var DashboardStyle: DashboardStyleRegistry;
}
