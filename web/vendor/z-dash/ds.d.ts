/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of the classic script ds.js: the global DS and the registry
 * ZDash (versions, runtime). Hand-written, like the module types
 * next to each module in js/*.d.ts (an import of js/<module>.js finds them
 * by itself). In a project with TypeScript or checkJs, reference this file:
 *
 *   /// <reference path="vendor/z-dash/ds.d.ts" />
 *
 * test/build.test.js keeps every declared export and its parameters equal
 * to the built modules.
 */
// generated: modules (scripts/build.mjs; do not edit)
import type * as core from './js/core.js';
import type * as motion from './js/motion.js';
import type * as indicator from './js/indicator.js';
import type * as dom from './js/dom.js';
import type * as ripple from './js/ripple.js';
import type * as icons from './js/icons.js';
import type * as position from './js/position.js';
import type * as overlay from './js/overlay.js';
import type * as a11y from './js/a11y.js';
import type * as hotkeys from './js/hotkeys.js';
import type * as format from './js/format.js';
import type * as store from './js/store.js';
import type * as virtual from './js/virtual.js';
import type * as dnd from './js/dnd.js';
import type * as ailabel from './js/ailabel.js';
import type * as auditlog from './js/auditlog.js';
import type * as avatar from './js/avatar.js';
import type * as backtop from './js/backtop.js';
import type * as badge from './js/badge.js';
import type * as bottomsheet from './js/bottomsheet.js';
import type * as calendar from './js/calendar.js';
import type * as chart from './js/chart.js';
import type * as cite from './js/cite.js';
import type * as command from './js/command.js';
import type * as composer from './js/composer.js';
import type * as copy from './js/copy.js';
import type * as datefield from './js/datefield.js';
import type * as dialog from './js/dialog.js';
import type * as diff from './js/diff.js';
import type * as duration from './js/duration.js';
import type * as errorsummary from './js/errorsummary.js';
import type * as expandable from './js/expandable.js';
import type * as feedback from './js/feedback.js';
import type * as filterbar from './js/filterbar.js';
import type * as facets from './js/facets.js';
import type * as form from './js/form.js';
import type * as formatted from './js/formatted.js';
import type * as highlight from './js/highlight.js';
import type * as code from './js/code.js';
import type * as hits from './js/hits.js';
import type * as image from './js/image.js';
import type * as inlineedit from './js/inlineedit.js';
import type * as kbd from './js/kbd.js';
import type * as kveditor from './js/kveditor.js';
import type * as labelgroup from './js/labelgroup.js';
import type * as levelmeter from './js/levelmeter.js';
import type * as lightbox from './js/lightbox.js';
import type * as list from './js/list.js';
import type * as listbox from './js/listbox.js';
import type * as choices from './js/choices.js';
import type * as combobox from './js/combobox.js';
import type * as listdetail from './js/listdetail.js';
import type * as loadingoverlay from './js/loadingoverlay.js';
import type * as loadmore from './js/loadmore.js';
import type * as logview from './js/logview.js';
import type * as markdown from './js/markdown.js';
import type * as media from './js/media.js';
import type * as menu from './js/menu.js';
import type * as datagrid from './js/datagrid.js';
import type * as menubutton from './js/menubutton.js';
import type * as message from './js/message.js';
import type * as number from './js/number.js';
import type * as object from './js/object.js';
import type * as orderedchoice from './js/orderedchoice.js';
import type * as otp from './js/otp.js';
import type * as page from './js/page.js';
import type * as password from './js/password.js';
import type * as picker from './js/picker.js';
import type * as daterange from './js/daterange.js';
import type * as plan from './js/plan.js';
import type * as popover from './js/popover.js';
import type * as prioritybar from './js/prioritybar.js';
import type * as query from './js/query.js';
import type * as question from './js/question.js';
import type * as search from './js/search.js';
import type * as secret from './js/secret.js';
import type * as selectpanel from './js/selectpanel.js';
import type * as sheet from './js/sheet.js';
import type * as shell from './js/shell.js';
import type * as shortcuts from './js/shortcuts.js';
import type * as sort from './js/sort.js';
import type * as splitbutton from './js/splitbutton.js';
import type * as splitpane from './js/splitpane.js';
import type * as steps from './js/steps.js';
import type * as suggestions from './js/suggestions.js';
import type * as tabs from './js/tabs.js';
import type * as taginput from './js/taginput.js';
import type * as tearsheet from './js/tearsheet.js';
import type * as terminal from './js/terminal.js';
import type * as timepicker from './js/timepicker.js';
import type * as datepicker from './js/datepicker.js';
import type * as timerange from './js/timerange.js';
import type * as toast from './js/toast.js';
import type * as banner from './js/banner.js';
import type * as notifications from './js/notifications.js';
import type * as toc from './js/toc.js';
import type * as toggle from './js/toggle.js';
import type * as toggletip from './js/toggletip.js';
import type * as tooltip from './js/tooltip.js';
import type * as tracker from './js/tracker.js';
import type * as transcript from './js/transcript.js';
import type * as transfer from './js/transfer.js';
import type * as tree from './js/tree.js';
import type * as jsonview from './js/jsonview.js';
import type * as truncate from './js/truncate.js';
import type * as typeconfirm from './js/typeconfirm.js';
import type * as unsaved from './js/unsaved.js';
import type * as upload from './js/upload.js';
import type * as views from './js/views.js';
import type * as wheel from './js/wheel.js';
import type * as thinking from './js/thinking.js';
import type * as reasoning from './js/reasoning.js';
import type * as toolcall from './js/toolcall.js';
import type * as usage from './js/usage.js';
import type * as wizard from './js/wizard.js';
// /generated: modules

/** What window.DS holds: the version, one namespace per module and the entry points of DS.core at the top level. */
export interface ZDashApi {
  /** The version of this copy (package.json at build time). */
  readonly version: string;
  /** DS.core.init: attaches every registered behaviour under a root and keeps watching it. */
  readonly init: typeof core.init;
  /** DS.core.get: the controller of an element. */
  readonly get: typeof core.get;
  /** DS.core.define: registers a behaviour by name. */
  readonly define: typeof core.define;
  /** DS.core.config: locale and strings. */
  readonly config: typeof core.config;
  // generated: namespaces (scripts/build.mjs; do not edit)
  readonly core: typeof core;
  readonly motion: typeof motion;
  readonly indicator: typeof indicator;
  readonly dom: typeof dom;
  readonly ripple: typeof ripple;
  readonly icons: typeof icons;
  readonly position: typeof position;
  readonly overlay: typeof overlay;
  readonly a11y: typeof a11y;
  readonly hotkeys: typeof hotkeys;
  readonly format: typeof format;
  readonly store: typeof store;
  readonly virtual: typeof virtual;
  readonly dnd: typeof dnd;
  readonly ailabel: typeof ailabel;
  readonly auditlog: typeof auditlog;
  readonly avatar: typeof avatar;
  readonly backtop: typeof backtop;
  readonly badge: typeof badge;
  readonly bottomsheet: typeof bottomsheet;
  readonly calendar: typeof calendar;
  readonly chart: typeof chart;
  readonly cite: typeof cite;
  readonly command: typeof command;
  readonly composer: typeof composer;
  readonly copy: typeof copy;
  readonly datefield: typeof datefield;
  readonly dialog: typeof dialog;
  readonly diff: typeof diff;
  readonly duration: typeof duration;
  readonly errorsummary: typeof errorsummary;
  readonly expandable: typeof expandable;
  readonly feedback: typeof feedback;
  readonly filterbar: typeof filterbar;
  readonly facets: typeof facets;
  readonly form: typeof form;
  readonly formatted: typeof formatted;
  readonly highlight: typeof highlight;
  readonly code: typeof code;
  readonly hits: typeof hits;
  readonly image: typeof image;
  readonly inlineedit: typeof inlineedit;
  readonly kbd: typeof kbd;
  readonly kveditor: typeof kveditor;
  readonly labelgroup: typeof labelgroup;
  readonly levelmeter: typeof levelmeter;
  readonly lightbox: typeof lightbox;
  readonly list: typeof list;
  readonly listbox: typeof listbox;
  readonly choices: typeof choices;
  readonly combobox: typeof combobox;
  readonly listdetail: typeof listdetail;
  readonly loadingoverlay: typeof loadingoverlay;
  readonly loadmore: typeof loadmore;
  readonly logview: typeof logview;
  readonly markdown: typeof markdown;
  readonly media: typeof media;
  readonly menu: typeof menu;
  readonly datagrid: typeof datagrid;
  readonly menubutton: typeof menubutton;
  readonly message: typeof message;
  readonly number: typeof number;
  readonly object: typeof object;
  readonly orderedchoice: typeof orderedchoice;
  readonly otp: typeof otp;
  readonly page: typeof page;
  readonly password: typeof password;
  readonly picker: typeof picker;
  readonly daterange: typeof daterange;
  readonly plan: typeof plan;
  readonly popover: typeof popover;
  readonly prioritybar: typeof prioritybar;
  readonly query: typeof query;
  readonly question: typeof question;
  readonly search: typeof search;
  readonly secret: typeof secret;
  readonly selectpanel: typeof selectpanel;
  readonly sheet: typeof sheet;
  readonly shell: typeof shell;
  readonly shortcuts: typeof shortcuts;
  readonly sort: typeof sort;
  readonly splitbutton: typeof splitbutton;
  readonly splitpane: typeof splitpane;
  readonly steps: typeof steps;
  readonly suggestions: typeof suggestions;
  readonly tabs: typeof tabs;
  readonly taginput: typeof taginput;
  readonly tearsheet: typeof tearsheet;
  readonly terminal: typeof terminal;
  readonly timepicker: typeof timepicker;
  readonly datepicker: typeof datepicker;
  readonly timerange: typeof timerange;
  readonly toast: typeof toast;
  readonly banner: typeof banner;
  readonly notifications: typeof notifications;
  readonly toc: typeof toc;
  readonly toggle: typeof toggle;
  readonly toggletip: typeof toggletip;
  readonly tooltip: typeof tooltip;
  readonly tracker: typeof tracker;
  readonly transcript: typeof transcript;
  readonly transfer: typeof transfer;
  readonly tree: typeof tree;
  readonly jsonview: typeof jsonview;
  readonly truncate: typeof truncate;
  readonly typeconfirm: typeof typeconfirm;
  readonly unsaved: typeof unsaved;
  readonly upload: typeof upload;
  readonly views: typeof views;
  readonly wheel: typeof wheel;
  readonly thinking: typeof thinking;
  readonly reasoning: typeof reasoning;
  readonly toolcall: typeof toolcall;
  readonly usage: typeof usage;
  readonly wizard: typeof wizard;
  // /generated: namespaces
}

/** @deprecated The name before the rename (3.0): use ZDashApi. */
export type DashboardStyleApi = ZDashApi;

/** Every copy of ds.js on the page, by version: a widget reads ZDash.versions['<its version>'] || DS. */
export interface ZDashRegistry {
  versions: Record<string, ZDashApi>;
  /** The page's one runtime, made by the copy that loaded first (DS.core.runtime). */
  readonly runtime: core.Runtime;
}

/** @deprecated The name before the rename (3.0): use ZDashRegistry. */
export type DashboardStyleRegistry = ZDashRegistry;

declare global {
  /** The first copy of ds.js on the page (a second copy of another version leaves it alone). */
  var DS: ZDashApi;
  var ZDash: ZDashRegistry;
  /** @deprecated The name before the rename (3.0): the same object as ZDash. */
  var DashboardStyle: ZDashRegistry;
}
