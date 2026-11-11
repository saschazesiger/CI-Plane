/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Core runtime (3.0): one shared runtime per page, the behaviour registry,
 * declarative initialisation, events and the system's own strings.
 *
 *   DS.core.define('copy', {                  // a behaviour, by name
 *     attribute: 'data-ds-copy',
 *     init(el, ctx) { el.addEventListener('click', copy, { signal: ctx.signal }); },
 *   });
 *   const page = DS.core.init(document);      // every behaviour on the page, now and later
 *   DS.core.get(el, 'copy');                  // its controller
 *   DS.core.emit(el, 'change', { value });    // a bubbling ds:change
 *   DS.core.config({ strings: { close: 'Schliessen' } });
 *   page.destroy();
 *
 * One runtime per page: globalThis.ZDash.runtime is created by
 * whichever copy loads first (a classic ds.js, a bundle, the ES modules)
 * and every later copy uses it. runtime.state(name, init) returns the
 * shared state of that name, made by init() the first time: the overlay
 * stack and the scroll lock (overlay.js), the installed action guards
 * (motion.js), the ripple delegation (ripple.js) and this module's
 * registry, controllers and observed roots. So two copies on one page
 * (a host page and a widget, a bundle and modules next to it) share one
 * Escape stack, one scroll lock and one guard per document.
 *
 * Registry: define(name, spec) adds a behaviour once per page (a second
 * definition of a name is ignored and returns false, so the copy loaded
 * first keeps it).
 * - spec.attribute: the data-ds-* attribute that marks an element, or
 *   spec.selector: a selector for elements without one.
 * - spec.init(el, ctx): returns a controller (an object with destroy()),
 *   a cleanup function, or nothing. ctx holds name, root, signal (an
 *   AbortSignal that aborts on destroy, for listeners), emit(type, detail,
 *   options) on el, and t(key, vars).
 * - spec.global(root): installed once per root of init() (a delegated
 *   behaviour: one listener on the root), returns a cleanup.
 * - spec.attributes: more attributes to observe (options of the
 *   behaviour). A change of one of them, or of spec.attribute, calls the
 *   controller's update(names) when it has one, else destroys it and
 *   initialises the element again. Never list an attribute the controller
 *   writes itself.
 * A behaviour defined after init() applies to the roots already
 * initialised.
 *
 * init(root, { observe }) installs every global on the root (always the
 * action guard of motion.js and the ripple delegation of ripple.js, and
 * the tooltips of the tooltip module) and initialises every matching element in
 * it, except inside [data-ds-managed] (a React adapter's root: the adapter
 * owns those elements and runs their behaviours through manage(); ripple,
 * guard and tooltips still serve them, being delegated;
 * data-ds-managed="off" inside one hands its subtree back). With observe (the default) one MutationObserver per root
 * watches childList and subtree, plus the attributes of every behaviour
 * (DS.dom.morphHtml patches in place: a new data-ds-* attribute arrives
 * without a childList record). Records are batched to a microtask; at the
 * flush, controllers go only for elements that are still disconnected, so a
 * keyed move without moveBefore() (a remove plus an add) keeps its
 * controller, and added or changed elements are initialised. A removal and
 * an insertion in separate tasks is a new element.
 * init() is idempotent: a second call on the same root rescans it and
 * holds it once more; the last handle's destroy() takes the root down
 * (globals, observer, controllers). A root inside a root already
 * initialised is rescanned only; a root around ones already initialised
 * takes them over. destroy(root) destroys at once every controller in
 * root (and the roots of init() in it), whatever holds them.
 *
 * Events: emit(el, type, detail, { cancelable }) dispatches a bubbling
 * CustomEvent `ds:<type>` and returns false when a listener called
 * preventDefault().
 *
 * Config: config({ locale, strings }) sets the page's locale (default: the
 * lang of <html>, else the browser's) and overrides the system's own few
 * texts (English by default); t(key, vars) reads one, with {name}
 * placeholders filled from vars (a string may also be a function of vars). A
 * change dispatches ds:config on the document, for what has text on screen.
 *
 * Links from data: safeHref(value) returns the value when it is safe to
 * write as an href or to navigate to (http, https, mailto, tel, or
 * relative: a path, a query, a #fragment), else null, so a javascript: or
 * data: URL that came with a notification, a banner or a search result
 * never runs. The components that write an href from data use it.
 *
 * ES2022; the first module of MODULES (scripts/build.mjs), so every other
 * module may import from it; no DOM is touched until init() runs.
 */

/**
 * The page-wide registry of every copy (ZDash.versions lives here too).
 * DashboardStyle is its deprecated name from before the rename (3.0): both
 * names hold the one object, so a copy that still reads the old name shares
 * the same runtime.
 */
const registry = globalThis.ZDash ?? globalThis.DashboardStyle ?? {};
globalThis.ZDash = registry;
globalThis.DashboardStyle ??= registry;

/** A new runtime: shared state by name. */
function createRuntime() {
  const states = new Map();
  return Object.freeze({
    /**
     * The shared state `name`, made by `init` (a function, or the value
     * itself) the first time any copy asks for it.
     */
    state(name, init) {
      if (!states.has(name)) states.set(name, typeof init === 'function' ? init() : init ?? {});
      return states.get(name);
    },
  });
}

/**
 * The one runtime of the page: the first copy that loads makes it, every
 * other copy (classic script, bundle or ES module) uses it.
 */
export const runtime = registry.runtime ?? createRuntimeOnce();

function createRuntimeOnce() {
  const made = createRuntime();
  Object.defineProperty(registry, 'runtime', { value: made, enumerable: true });
  return made;
}

/** The system's own texts, English; a page overrides them with config({ strings }). */
const DEFAULT_STRINGS = Object.freeze({
  close: 'Close',
  copy: 'Copy',
  copied: 'Copied',
  showMore: 'Show more',
  showLess: 'Show less',
  clear: 'Clear',
  loading: 'Loading',
  more: 'More',
  dismiss: 'Dismiss',
  required: 'Required',
  optional: 'Optional',
  ok: 'OK',
  cancel: 'Cancel',
  confirm: 'Confirm',
  actionFailed: 'That did not work. Try again.',
  valueRequired: 'Enter a value.',
  expand: 'Expand',
  collapse: 'Collapse',
  remove: 'Remove',
  previous: 'Previous',
  next: 'Next',
  noResults: 'No results',
  keyCtrl: 'Ctrl',
  keyAlt: 'Alt',
  keyShift: 'Shift',
  keyMeta: 'Win',
  keyEnter: 'Enter',
  keyEscape: 'Esc',
  keySpace: 'Space',
  keyTab: 'Tab',
  keyBackspace: 'Backspace',
  keyDelete: 'Delete',
  keyHome: 'Home',
  keyEnd: 'End',
  keyPageUp: 'Page Up',
  keyPageDown: 'Page Down',
  hotkeysGeneral: 'General',
  dragHint: 'Press Space to pick up. Then the arrow keys move it, Space drops it and Escape cancels.',
  dragGrabbed: 'Picked up {label}, position {position} of {total}.',
  dragMoved: 'Moved {label} to position {position} of {total}.',
  dragMovedZone: 'Moved {label} to {zone}, position {position} of {total}.',
  dragDropped: 'Dropped {label} at position {position} of {total}.',
  dragDroppedZone: 'Dropped {label} in {zone}, position {position} of {total}.',
  dragCancelled: 'Cancelled. {label} is back at position {position} of {total}.',
  splitpaneResize: 'Resize',
  splitpaneCollapsed: 'Collapsed',
  back: 'Back',
  moreOptionsFor: 'More options for {label}',
  moreActions: 'More actions',
  copyManual: 'Copying is blocked here. The text is selected: press {keys} to copy it.',
  decrease: 'Decrease',
  increase: 'Increase',
  showPassword: 'Show password',
  capsLock: 'Caps Lock is on.',
  strengthWeak: 'Weak',
  strengthFair: 'Fair',
  strengthGood: 'Good',
  strengthStrong: 'Strong',
  passwordStrength: 'Password strength: {level}',
  secretSet: 'Set',
  secretNotSet: 'Not set',
  secretCleared: 'Removed when you save',
  recentSearches: 'Recent searches',
  clearRecent: 'Clear recent searches',
  searchResultsOne: '{count} result',
  searchResultsMany: '{count} results',
  edit: 'Edit',
  save: 'Save',
  saved: 'Saved',
  typeToConfirm: 'Type {name} to confirm',
  errorSummaryOne: 'There is 1 problem',
  errorSummaryMany: 'There are {count} problems',
  otpDigit: 'Digit {index} of {count}',
  otpCharacter: 'Character {index} of {count}',
  charactersLeft: '{count} characters left',
  charactersLeftOne: '1 character left',
  charactersOver: '{count} characters too many',
  charactersOverOne: '1 character too many',
  errorSummaryField: '{label}: {message}',
  createOption: 'Create “{text}”',
  resultsOther: '{count} results',
  typeToSearch: 'Type to search',
  added: 'Added {label}',
  removed: 'Removed {label}',
  selectedCount: '{count} selected',
  tagDuplicate: '{label} is in the list already',
  tagInvalid: '{label} is not valid',
  tagMax: 'Up to {max} items',
  allSelected: 'All selected',
  orderPosition: 'Position {position}',
  transferMoved: 'Moved {count} to {list}',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  selected: 'selected',
  chooseDate: 'Choose date',
  chooseDates: 'Choose dates',
  chooseTime: 'Choose time',
  empty: 'Empty',
  rangeStart: 'Start',
  rangeEnd: 'End',
  presets: 'Presets',
  lastSpan: 'Last {span}',
  timeRange: 'Time range',
  absoluteRange: 'Absolute time range',
  rangeFrom: 'From',
  rangeTo: 'To',
  apply: 'Apply',
  recentRanges: 'Recently used',
  quickRanges: 'Quick ranges',
  refresh: 'Refresh',
  autoRefresh: 'Auto refresh',
  off: 'Off',
  rangeOrder: 'The start must come before the end.',
  retry: 'Retry',
  uploadWaiting: 'Waiting',
  uploadDone: 'Uploaded',
  uploadFailed: 'Upload failed',
  uploadRetry: 'Retry {name}',
  uploadRemove: 'Remove {name}',
  uploadProgress: 'Upload of {name}',
  uploadWrongType: '{name} is not a type this field takes.',
  uploadTooMany: '{name} was not added: at most {max} files.',
  uploadTooLarge: '{name} is larger than {max}.',
  uploadEmpty: '{name} is empty.',
  uploadAdded: 'Added {name}.',
  uploadAddedCount: 'Added {count} files.',
  uploadRemoved: 'Removed {name}.',
  uploadDoneAnnounce: '{name} uploaded.',
  uploadFailedAnnounce: 'Upload of {name} failed.',
  kvAdd: 'Add row',
  kvKeyLabel: 'Key, row {row}',
  kvValueLabel: 'Value, row {row}',
  kvValueOf: 'Value of {key}',
  kvRemove: 'Remove {key}',
  kvRemoveRow: 'Remove row {row}',
  kvShow: 'Show the value of {key}',
  kvShowRow: 'Show the value of row {row}',
  kvDuplicate: '{key} is also on row {rows}: the last one counts.',
  kvNoKey: 'Add a key, or this row is left out.',
  kvRemoved: 'Removed {key}.',
  kvRemovedRow: 'Removed a row.',
  kvPasted: 'Pasted {count} rows.',
  wizardDone: 'done',
  wizardFix: 'Needs attention',
  wizardStepOf: 'Step {index} of {count}',
  wizardStep: 'Step {index} of {count}: {label}',
  wizardError: 'One field needs attention.',
  wizardErrors: '{count} fields need attention.',
  wizardEmpty: 'Not given',
  wizardEdit: 'Edit {label}',
  wizardEditShort: 'Edit',
  wizardYes: 'Yes',
  wizardNo: 'No',
  unsavedOne: '1 unsaved change',
  unsavedMany: '{count} unsaved changes',
  unsavedSaveKey: 'Save changes',
  unsavedSaved: 'Changes saved.',
  unsavedFailed: 'Not saved. Your changes are still here.',
  unsavedDiscarded: 'Changes discarded.',
  unsavedLeaveTitle: 'Leave without saving?',
  unsavedLeaveText: 'Your unsaved changes will be lost.',
  unsavedLeave: 'Discard changes',
  unsavedStay: 'Keep editing',
  unsavedChangedWord: '(changed)',
  queryIs: 'is',
  queryNot: 'is not',
  queryGt: 'over',
  queryGte: 'at least',
  queryLt: 'under',
  queryLte: 'at most',
  queryOr: 'or',
  queryText: 'Text',
  queryRemove: 'Remove filter',
  queryTokenHint: 'Backspace or Delete removes it, F2 edits it.',
  queryUnknownKey: '(not a known filter)',
  queryBadOp: '(this filter does not compare)',
  queryBadValue: '(not a valid value)',
  querySuggestions: 'Suggestions',
  queryKeys: 'Filter by',
  queryOperators: 'Compare',
  querySaved: 'Saved queries',
  querySearch: 'Search',
  querySearchFor: 'Search for "{text}"',
  queryOne: '1 suggestion',
  queryMany: '{count} suggestions',
  queryNoMatch: 'No suggestions',
  queryUnknown: 'Not a known filter',
  querySavedHint: 'Enter applies this saved query, Delete removes it.',
  queryAdded: 'Added filter {label}.',
  queryRemoved: 'Removed filter {label}.',
  queryEditing: 'Editing filter {label}.',
  queryCleared: 'Cleared the query.',
  queryApplied: 'Applied {name}.',
  queryClear: 'Clear the query',
  querySave: 'Save this query',
  querySaveTitle: 'Save the query',
  querySaveName: 'Name',
  querySaveConfirm: 'Save',
  querySavedAs: 'Saved the query as {name}.',
  querySavedRemoved: 'Removed the saved query {name}.',
  datagridSelect: 'Select',
  datagridSelectAll: 'Select all rows',
  datagridSelectRow: 'Select {label}',
  datagridSelected: '{count} selected',
  datagridSelectEvery: 'Select all {total}',
  datagridSelectedEvery: 'All {total} selected',
  datagridDetails: 'Details',
  datagridDetailsOf: 'Details of {label}',
  datagridActions: 'Actions',
  datagridSorted: 'Sorted by {column}, {direction}.',
  datagridUnsorted: 'Sorting removed.',
  datagridSortRank: ', sort {rank}, {direction}',
  datagridAscending: 'ascending',
  datagridDescending: 'descending',
  datagridResize: 'Resize {column}',
  datagridMove: 'Move {column}',
  datagridColumns: 'Columns',
  datagridPresets: 'Views',
  datagridPresetDefault: 'Default',
  datagridPresetAll: 'All columns',
  datagridPresetApplied: '{preset} shown.',
  datagridColumnShown: '{column} shown.',
  datagridColumnHidden: '{column} hidden.',
  datagridRowsOne: '{count} row',
  datagridRowsOther: '{count} rows',
  datagridPage: 'Page {page} of {pages}',
  datagridRange: '{from}–{to} of {total}',
  datagridTotal: 'Total',
  datagridNoValue: 'No value',
  datagridEmpty: 'Nothing here yet',
  datagridNoResultsText: 'Nothing matches the filter.',
  datagridError: 'The data did not load.',
  datagridRetry: 'Try again',
  datagridInvalidNumber: 'Enter a number.',
  datagridEditSaved: '{column} saved.',
  datagridEditRefused: '{column} not saved.',
  datagridCopiedOne: '{count} row copied.',
  datagridCopiedOther: '{count} rows copied.',
  sortAscending: 'Ascending',
  sortDescending: 'Descending',
  sortAscendingText: 'A to Z',
  sortDescendingText: 'Z to A',
  sortAscendingNumber: 'Lowest first',
  sortDescendingNumber: 'Highest first',
  sortAscendingDate: 'Oldest first',
  sortDescendingDate: 'Newest first',
  sortAnnounce: 'Sorted by {field}, {direction}',
  loadMoreStatus: 'Showing {loaded} of {total}',
  loadMoreStatusOpen: 'Showing {loaded}',
  loadMoreDone: 'All {total} shown',
  loadMoreLoaded: 'Loaded {count} more.',
  loadMoreLoading: 'Loading more',
  loadMoreFailed: 'Could not load more.',
  tryAgain: 'Try again',
  removeFilter: 'Remove filter',
  filterRemoved: 'Removed {filter}',
  filtersCleared: 'Filters cleared',
  filtersApplied: '{count} applied',
  filterChip: '{label}: {value}',
  resultsOne: '{count} result',
  showResults: 'Show {results}',
  rangeMin: 'from {min}',
  rangeMax: 'up to {max}',
  rangeBetween: '{min} to {max}',
  facetShowAll: 'Show all {count}',
  facetShowFewer: 'Show fewer',
  facetNoMatch: 'No match for “{query}”',
  facetMatchesOne: '{count} match',
  facetMatchesOther: '{count} matches',
  viewEdited: 'Edited',
  viewDefault: 'Default',
  viewApplied: 'View: {name}',
  viewSaved: 'Saved {name}',
  viewDeleted: 'Deleted {name}',
  viewDefaultSet: '{name} is the default view',
  viewLinkCopied: 'Link copied',
  viewNameLabel: 'Name',
  viewNewTitle: 'Save as a new view',
  viewRenameTitle: 'Rename view',
  viewSave: 'Save',
  viewLinkTitle: 'Link to this view',
  viewDeleteTitle: 'Delete “{name}”?',
  viewDeleteText: 'The view goes from this browser. The list and its data stay as they are.',
  viewDeleteConfirm: 'Delete view',
  treeMove: 'Move {label}',
  treeMoveBefore: 'Before {target}, in {parent}.',
  treeMoveAfter: 'After {target}, in {parent}.',
  treeMoveInside: 'Into {target}.',
  treeDropped: 'Moved {label} to {parent}, position {position} of {total}.',
  treeLoaded: 'Loaded {label}.',
  treeLoadFailed: 'Could not load {label}.',
  treeError: 'Could not load',
  jsonTree: 'JSON',
  jsonSearch: 'Search keys and values',
  jsonFind: 'Search',
  jsonPrevious: 'Previous match',
  jsonNext: 'Next match',
  jsonMatch: '{current} of {total}',
  jsonExpandAll: 'Expand all',
  jsonCollapseAll: 'Collapse all',
  jsonCopyValue: 'Copy the value of {label}',
  jsonCopyPath: 'Copy the path of {label}',
  jsonKey: '{count} key',
  jsonKeys: '{count} keys',
  jsonItem: '{count} item',
  jsonItems: '{count} items',
  jsonInvalid: 'Not valid JSON: line {line}, column {column}.',
  listMove: 'Move {label}',
  listSelected: '{count} selected',
  factsCopy: 'Copy {label}',
  auditlogToday: 'Today',
  auditlogYesterday: 'Yesterday',
  auditlogUndated: 'No date',
  auditlogBefore: 'Before:',
  auditlogAfter: 'After:',
  auditlogNotSet: 'Not set',
  auditlogEvent: '{count} event',
  auditlogEvents: '{count} events',
  auditlogFiltered: '{shown} of {total} events',
  auditlogMore: 'Show {count} more',
  kbdCommand: 'Command',
  kbdOption: 'Option',
  kbdControl: 'Control',
  kbdThen: 'then',
  labelGroupMore: '+{count} more, show all {total}',
  labelGroupAll: 'All labels',
  chartTableView: 'Show as table',
  chartRole: 'chart',
  chartKeys: 'Left and Right move along the points, Up and Down through the series, Page Up and Page Down jump, Home and End go to the ends.',
  chartKeysBars: 'Arrow keys move along the bars, Page Up and Page Down jump, Home and End go to the ends.',
  chartKeysSlices: 'Arrow keys move through the slices, Home and End go to the ends.',
  chartPoint: '{x}: {values}',
  chartSummary: '{name}: from {first} to {last}, lowest {min}, highest {max}',
  chartTotal: 'Total',
  chartOther: 'Other',
  chartShown: '{series} shown',
  chartHidden: '{series} hidden',
  chartEmpty: 'No data',
  moreInfo: 'More information',
  done: 'Done',
  commandOpen: 'Open the command palette',
  commandRecent: 'Recent',
  commandResults: '{count} results',
  commandResultOne: '1 result',
  commandEmpty: 'No results for "{query}"',
  commandFailed: 'Some results could not be loaded.',
  commandBack: 'Back to {page}',
  shortcutsOpen: 'Show the keyboard shortcuts',
  shortcutsGlobal: 'Everywhere',
  shortcutsOff: 'Not available here',
  shortcutsOr: 'or',
  shortcutsEmpty: 'No keyboard shortcuts here.',
  notificationsCount: '{label}, {count} unread',
  notificationsUnread: 'Unread',
  notificationsMarkRead: 'Mark as read',
  notificationsMarkUnread: 'Mark as unread',
  notificationsAllRead: 'All notifications marked as read.',
  notificationsArrived: 'New notification: {title}',
  notificationsArrivedMany: '{count} new notifications',
  notificationsToday: 'Today',
  notificationsYesterday: 'Yesterday',
  notificationsEarlier: 'Earlier',
  notificationsEmpty: 'No notifications',
  notificationsUnreadCount: '{count} unread',
  notificationsError: 'Error',
  notificationsWarning: 'Warning',
  notificationsSuccess: 'Success',
  bannerMore: 'Show {count} more',
  resizePanel: 'Resize the panel',
  stepOf: 'Step {step} of {total}: {label}',
  stepDone: ', done',
  stepError: ', needs attention',
  discardTitle: 'Discard your changes?',
  discardText: 'What you entered is lost.',
  discard: 'Discard',
  keepEditing: 'Keep editing',
  imageOf: 'Image {index} of {total}',
  images: 'Images',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  imageFailed: 'The image could not be loaded.',
  resizeSheet: 'Resize the sheet',
  sheetDetent: 'Sheet at {percent} percent of the screen',
  filterMatch: '{count} match',
  filterMatches: '{count} matches',
  breadcrumbsMore: 'Show {count} more',
  moreTabs: 'More tabs',
  tabClosed: '{label} closed',
  closeTab: 'Close {label}',
  backToTop: 'Back to top',
  editing: 'Editing {label}',
  sectionSaved: '{label} saved',
  presenceOnline: 'Online',
  presenceAway: 'Away',
  presenceBusy: 'Busy',
  presenceOffline: 'Offline',
  avatarStatus: '{name}, {status}',
  avatarMore: '{count} more',
  avatarOverflow: '+{count}',
  mediaSelected: '{count} selected',
  mediaSelectionCleared: 'Selection cleared',
  levelmeterValue: '{value} dB',
  levelmeterLoud: 'Too loud',
  copyCode: 'Copy code',
  codeBlock: 'Code',
  wrapLines: 'Wrap lines',
  footnotes: 'Footnotes',
  footnoteBack: 'Back to reference {number}',
  calloutNote: 'Note',
  calloutTip: 'Tip',
  calloutImportant: 'Important',
  calloutWarning: 'Warning',
  calloutCaution: 'Caution',
  diffAdded: 'Added',
  diffRemoved: 'Removed',
  diffStats: '{added} added, {removed} removed',
  diffFileAdded: 'New file',
  diffFileDeleted: 'Deleted',
  diffFileRenamed: 'Renamed',
  diffFileCopied: 'Copied',
  diffFileBinary: 'Binary',
  diffBinary: 'Binary file, not shown',
  diffNoChanges: 'No changes',
  diffUntitled: 'Untitled',
  diffNoNewline: 'No newline at end of file',
  diffExpandOne: 'Show 1 unchanged line',
  diffExpand: 'Show {count} unchanged lines',
  diffShownOne: '1 more line shown',
  diffShown: '{count} more lines shown',
  diffOldLine: 'Old line',
  diffNewLine: 'New line',
  diffChange: 'Change',
  diffCode: 'Code',
  diffOldCode: 'Before',
  diffNewCode: 'After',
  logName: 'Log',
  logFatal: 'Fatal',
  logError: 'Error',
  logWarn: 'Warning',
  logInfo: 'Info',
  logDebug: 'Debug',
  logTrace: 'Trace',
  logLevels: 'Levels',
  logSearch: 'Search the log',
  logSearchPlaceholder: 'Search',
  logPrevious: 'Previous match',
  logNext: 'Next match',
  logMatch: '{index} of {count}',
  logMatchesOne: '1 match',
  logMatches: '{count} matches',
  logOnlyMatches: 'Only matching lines',
  logWrap: 'Wrap lines',
  logTimestamps: 'Timestamps',
  logCopyLine: 'Copy line',
  logCopyLines: 'Copy {count} lines',
  logCopiedOne: 'Copied 1 line',
  logCopied: 'Copied {count} lines',
  logSelected: '{count} lines selected',
  logLinesOne: '1 line',
  logLines: '{count} lines',
  logShown: '{shown} of {count} lines',
  logEmpty: 'No lines yet',
  logBlank: 'Blank line',
  logNoneShown: 'No line matches the filters',
  logLatest: 'Latest',
  logFollowing: 'Following new lines',
  terminalKeys: 'Terminal keys',
  terminalUp: 'Arrow up',
  terminalDown: 'Arrow down',
  terminalLeft: 'Arrow left',
  terminalRight: 'Arrow right',
  terminalConnecting: 'Connecting',
  terminalConnected: 'Connected',
  terminalDisconnected: 'Disconnected',
  terminalHeld: '{key} held for the next key',
  terminalReleased: '{key} released',
  send: 'Send',
  stop: 'Stop',
  removeNamed: 'Remove {name}',
  filesAttached: 'Attached {names}',
  fileRemoved: 'Removed {name}',
  resultCount: 'Results: {count}',
  latest: 'Latest',
  unreadCount: '{count} new',
  earlierLoaded: 'Earlier messages loaded',
  messageStopped: 'Stopped',
  messageFailed: 'Not completed',
  feedbackThanks: 'Thanks for the feedback',
  tokensOne: '{count} token',
  tokensOther: '{count} tokens',
  reasoningRunning: 'Thinking',
  reasoningDone: 'Thought for {time}',
  toolStatus: '{name}: {status}',
  toolPending: 'Pending',
  toolRunning: 'Running',
  toolDone: 'Done',
  toolFailed: 'Failed',
  toolCancelled: 'Cancelled',
  usageOf: '{used} of {budget}',
  usageShare: '{percent} used',
  usageNear: 'Near the budget',
  usageOver: 'Over budget',
  planWaiting: 'Waiting for approval',
  planApproved: 'Approved',
  planRejected: 'Rejected',
  questionAnswered: 'Answered: {answer}',
  questionSkipped: 'Skipped',
  questionRequired: 'Choose an answer.',
});

/**
 * This module's shared state (runtime.state('core')): the behaviours by
 * name, the controllers of each element (name to entry), the roots of
 * init() and the page's settings (locale, overridden strings).
 * @type {{ specs: Map<string, any>, elements: WeakMap<Element, Map<string, any>>, roots: Map<Node, any>, settings: { locale: string|null, strings: Record<string, any>, version?: number } }}
 */
const core = runtime.state('core', () => ({
  specs: new Map(),
  elements: new WeakMap(),
  roots: new Map(),
  settings: { locale: null, strings: {} },
}));

/** The attribute that hands a subtree to someone else (the React adapter). */
const MANAGED = 'data-ds-managed';

const NAME = /^[a-z][\w-]*$/;
const ATTRIBUTE = /^data-ds-[a-z0-9][a-z0-9-]*$/;

const noop = () => {};

function report(error) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else globalThis.console?.error?.(error);
}

const isNode = (value) => Boolean(value) && typeof value === 'object' && typeof value.nodeType === 'number';
const viewOf = (node) => (node.nodeType === 9 ? node : node.ownerDocument)?.defaultView ?? globalThis;
/**
 * Whether an owner runs the behaviours of `element`: the nearest
 * [data-ds-managed] at or above it, unless that one says "off" (a part of
 * a managed subtree handed back to init(), such as the content slot of an
 * adapter component).
 */
const isManaged = (element) => {
  const owner = element.closest?.(`[${MANAGED}]`);
  return Boolean(owner) && owner.getAttribute(MANAGED) !== 'off';
};

/** The behaviours that initialise elements, as [name, spec]. */
const elementSpecs = () => [...core.specs].filter(([, spec]) => spec.init);

/** Every attribute an observer watches. */
function watchedAttributes() {
  const names = new Set([MANAGED]);
  for (const spec of core.specs.values()) {
    if (spec.attribute) names.add(spec.attribute);
    for (const name of spec.attributes) names.add(name);
  }
  return [...names];
}

/* ── Registry ───────────────────────────────────────── */

/**
 * Adds the behaviour `name` to the page's registry (see the header).
 * Returns true, or false when a copy loaded earlier defined the name.
 * @param {string} name
 * @param {object} spec
 * @returns {boolean}
 */
export function define(name, spec) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`DS.core.define: "${name}" is no behaviour name (lower case, digits, - and _)`);
  if (!spec || typeof spec !== 'object') throw new TypeError(`DS.core.define("${name}"): a spec object`);
  if (core.specs.has(name)) return false;
  const attribute = spec.attribute ?? null;
  if (attribute !== null && (typeof attribute !== 'string' || !ATTRIBUTE.test(attribute))) throw new TypeError(`DS.core.define("${name}"): attribute must be a data-ds-* name`);
  if (typeof spec.init !== 'function' && typeof spec.global !== 'function') throw new TypeError(`DS.core.define("${name}"): init(el, ctx) or global(root)`);
  if (spec.init && !attribute && typeof spec.selector !== 'string') throw new TypeError(`DS.core.define("${name}"): init() needs an attribute or a selector`);
  const match = typeof spec.selector === 'string' ? spec.selector : attribute ? `[${attribute}]` : null;
  if (match && typeof globalThis.document?.createDocumentFragment === 'function') {
    try {
      globalThis.document.createDocumentFragment().querySelector(match);
    } catch {
      throw new TypeError(`DS.core.define("${name}"): "${match}" is no selector`);
    }
  }
  const attributes = Object.freeze([...(spec.attributes ?? [])].map(String));
  const entry = Object.freeze({
    attribute,
    match,
    attributes,
    init: typeof spec.init === 'function' ? spec.init : null,
    global: typeof spec.global === 'function' ? spec.global : null,
  });
  core.specs.set(name, entry);
  // The roots already initialised get it too.
  for (const state of [...core.roots.values()]) {
    if (entry.global) installGlobal(state, name, entry);
    if (entry.init) scan(state.root, state, [[name, entry]]);
    if (state.observer) connect(state);
  }
  return true;
}

/* ── Controllers ────────────────────────────────────── */

function attachOne(element, name, spec, state) {
  let entries = core.elements.get(element);
  if (entries?.has(name)) return;
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const ctx = Object.freeze({
    name,
    root: state.root,
    signal: abort?.signal ?? null,
    emit: (type, detail, options) => emit(element, type, detail, options),
    t,
  });
  let result;
  try {
    result = spec.init(element, ctx);
  } catch (error) {
    abort?.abort();
    report(error);
    return;
  }
  const controller = result && typeof result === 'object' ? result : null;
  const cleanup = typeof result === 'function' ? result : typeof controller?.destroy === 'function' ? () => controller.destroy() : null;
  if (!entries) core.elements.set(element, (entries = new Map()));
  entries.set(name, {
    state,
    abort,
    cleanup,
    controller,
    handle: controller ?? Object.freeze({ destroy: () => detachOne(element, name) }),
  });
  state.live.add(element);
}

function detachOne(element, name) {
  const entries = core.elements.get(element);
  const entry = entries?.get(name);
  if (!entry) return;
  entries.delete(name);
  if (!entries.size) core.elements.delete(element);
  if (![...(entries.values())].some((other) => other.state === entry.state)) entry.state.live.delete(element);
  entry.abort?.abort();
  try {
    entry.cleanup?.();
  } catch (error) {
    report(error);
  }
}

/** Destroys the controllers of `element` (those of one root state, or all). */
function detachAll(element, state) {
  const entries = core.elements.get(element);
  if (!entries) {
    state?.live.delete(element);
    return;
  }
  for (const [name, entry] of [...entries]) if (!state || entry.state === state) detachOne(element, name);
}

/** Initialises every element in `node` (itself included) that a behaviour matches. */
function scan(node, state, specs = elementSpecs()) {
  if (!specs.length || typeof node?.querySelectorAll !== 'function') return;
  if (node.nodeType === 1 && isManaged(node)) {
    // The parts of it handed back (data-ds-managed="off") are scanned on their own.
    for (const slot of node.querySelectorAll(`[${MANAGED}="off"]`)) {
      const outer = slot.parentNode;
      if (outer?.nodeType === 1 && isManaged(outer)) scan(slot, state, specs);
    }
    return;
  }
  const selector = specs.map(([, spec]) => spec.match).join(', ');
  const found = node.nodeType === 1 && node.matches(selector) ? [node] : [];
  for (const element of node.querySelectorAll(selector)) found.push(element);
  for (const element of found) {
    if (element !== node && isManaged(element)) continue;
    for (const [name, spec] of specs) if (element.matches(spec.match)) attachOne(element, name, spec, state);
  }
}

/** After attribute changes on a connected element: initialise, update, re-initialise or destroy. */
function reconcile(element, changed, state) {
  if (isManaged(element)) return;
  for (const [name, spec] of elementSpecs()) {
    const names = [spec.attribute, ...spec.attributes].filter((attribute) => attribute && changed.has(attribute));
    if (!names.length) continue;
    const entry = core.elements.get(element)?.get(name);
    const matches = element.matches(spec.match);
    if (!entry) {
      if (matches) attachOne(element, name, spec, state);
    } else if (!matches) detachOne(element, name);
    else if (typeof entry.controller?.update === 'function') {
      try {
        entry.controller.update(names);
      } catch (error) {
        report(error);
      }
    } else {
      detachOne(element, name);
      attachOne(element, name, spec, state);
    }
  }
}

/**
 * The controller of `el` for the behaviour `name` (without a name: its
 * first one), or null. A behaviour whose init() returned a function or
 * nothing has a handle with destroy() only.
 * @param {Element} el
 * @param {string} [name]
 * @returns {any}
 */
export function get(el, name) {
  const entries = el ? core.elements.get(el) : undefined;
  if (!entries) return null;
  const entry = name === undefined ? entries.values().next().value : entries.get(name);
  return entry?.handle ?? null;
}

/**
 * Runs the behaviour `name` on `el` for an owner that renders the element
 * itself (the React adapter, on a root marked [data-ds-managed], which
 * init() and its observer leave alone). The behaviour's own init() makes
 * the controller, as for markup that init() finds, so the element's
 * data-ds-* attributes are its options; get(el, name) returns it. An
 * element that does not match the behaviour yet (its attribute not
 * written) gets its controller once update() sees it match. Returns a
 * handle, or null when no behaviour `name` initialises elements (its module
 * is not loaded):
 * - controller: the controller (null when init() returned a function or
 *   nothing, or once destroyed);
 * - update(): after the owner changed attributes of the element, does what
 *   the observer does for a change of the behaviour's attributes (the
 *   controller's update(names), else a fresh controller);
 * - destroy(): destroys the controller; safe to call twice (a React
 *   StrictMode effect runs its cleanup and then the effect once more).
 * A controller that a root of init() made already (the element was not
 * managed then) stays that root's: the handle reads it and leaves it.
 * @param {Element} el
 * @param {string} name
 * @returns {{ readonly controller: any, update(): void, destroy(): void } | null}
 */
export function manage(el, name) {
  const spec = core.specs.get(name);
  if (!spec?.init || !isNode(el) || el.nodeType !== 1) return null;
  const state = { root: el.getRootNode?.() ?? el.ownerDocument, live: new Set() };
  const watched = [spec.attribute, ...spec.attributes].filter(Boolean);
  const read = () => watched.map((attribute) => el.getAttribute(attribute));
  // Without its attribute (yet), nothing runs; update() starts it once the owner writes it.
  if (el.matches(spec.match)) attachOne(el, name, spec, state);
  let seen = read();
  let held = true;
  const own = () => {
    const entry = core.elements.get(el)?.get(name);
    return entry?.state === state ? entry : null;
  };
  return {
    get controller() {
      return held ? core.elements.get(el)?.get(name)?.controller ?? null : null;
    },
    update() {
      if (!held) return;
      const now = read();
      const names = watched.filter((attribute, index) => now[index] !== seen[index]);
      seen = now;
      if (!names.length) return;
      const entry = own();
      const matches = el.matches(spec.match);
      if (!entry) {
        // Its attribute came back: a fresh controller, unless a root of init() holds one.
        if (matches && !core.elements.get(el)?.has(name)) attachOne(el, name, spec, state);
      } else if (!matches) detachOne(el, name);
      else if (typeof entry.controller?.update === 'function') {
        try {
          entry.controller.update(names);
        } catch (error) {
          report(error);
        }
      } else {
        detachOne(el, name);
        attachOne(el, name, spec, state);
      }
    },
    destroy() {
      if (!held) return;
      held = false;
      if (own()) detachOne(el, name);
    },
  };
}

/* ── Roots ──────────────────────────────────────────── */

function installGlobal(state, name, spec) {
  if (state.globals.has(name)) return;
  let result;
  try {
    result = spec.global(state.root);
  } catch (error) {
    report(error);
    return;
  }
  state.globals.set(name, typeof result === 'function' ? result : typeof result?.destroy === 'function' ? () => result.destroy() : noop);
}

function connect(state) {
  state.observer.observe(state.root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: watchedAttributes(),
  });
}

function startObserver(state) {
  const Observer = viewOf(state.root).MutationObserver ?? globalThis.MutationObserver;
  if (typeof Observer !== 'function') return;
  state.observer = new Observer((records) => {
    state.pending.push(...records);
    if (state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => flush(state));
  });
  connect(state);
}

/** One batch of records: removals (still disconnected), attribute changes, additions. */
function flush(state) {
  state.scheduled = false;
  if (core.roots.get(state.root) !== state) return;
  const records = state.pending.concat(state.observer?.takeRecords?.() ?? []);
  state.pending = [];
  let removals = false;
  const added = new Set();
  const changed = new Map();
  for (const record of records) {
    if (record.type === 'childList') {
      if (record.removedNodes.length) removals = true;
      for (const node of record.addedNodes) if (node.nodeType === 1) added.add(node);
    } else if (record.type === 'attributes') {
      const element = record.target;
      if (element.getAttribute(record.attributeName) === record.oldValue) continue;
      if (!changed.has(element)) changed.set(element, new Set());
      changed.get(element).add(record.attributeName);
    }
  }
  // A node that came back in the same batch (a keyed move) is connected again and keeps its controllers.
  if (removals) for (const element of [...state.live]) if (!element.isConnected) detachAll(element);
  for (const [element, names] of changed) {
    if (!element.isConnected) {
      detachAll(element);
      continue;
    }
    // A subtree handed back (data-ds-managed removed) is scanned like an added one.
    if (names.has(MANAGED)) added.add(element);
    reconcile(element, names, state);
  }
  for (const node of added) {
    if (!node.isConnected) continue;
    let covered = false;
    for (let parent = node.parentNode; parent && !covered; parent = parent.parentNode) covered = added.has(parent);
    if (!covered) scan(node, state);
  }
}

/** Takes one root down: globals (last installed first), observer, controllers. */
function teardown(state) {
  if (core.roots.get(state.root) !== state) return;
  core.roots.delete(state.root);
  state.observer?.disconnect();
  state.observer = null;
  state.pending = [];
  for (const cleanup of [...state.globals.values()].reverse()) {
    try {
      cleanup();
    } catch (error) {
      report(error);
    }
  }
  state.globals.clear();
  for (const element of [...state.live]) detachAll(element, state);
}

const holds = (outer, inner) => outer !== inner && typeof outer.contains === 'function' && outer.contains(inner);

/**
 * Initialises `root` (default: the document): installs every global
 * behaviour on it (the action guard and the ripple delegation always),
 * initialises every matching element outside [data-ds-managed] and, with
 * `observe` (default true), keeps doing so for added, changed and removed
 * elements. Idempotent; see the header.
 * @param {Document|Element|ShadowRoot} [root]
 * @param {{ observe?: boolean }} [options]
 * @returns {{ destroy: () => void }}
 */
export function init(root = globalThis.document, options = {}) {
  if (!isNode(root) || typeof root.querySelectorAll !== 'function') return { destroy: noop };
  const observe = options.observe ?? true;
  // Inside a root already initialised: that root's globals and observer serve it.
  const outer = [...core.roots.values()].find((other) => holds(other.root, root));
  if (outer) {
    scan(root, outer);
    let held = true;
    return {
      destroy() {
        if (!held) return;
        held = false;
        destroy(root);
      },
    };
  }
  let state = core.roots.get(root);
  if (state) state.holders += 1;
  else {
    state = { root, holders: 1, globals: new Map(), live: new Set(), observer: null, pending: [], scheduled: false };
    // Roots inside this one are taken over: their globals and observers go, their controllers stay.
    for (const inner of [...core.roots.values()].filter((other) => holds(root, other.root))) {
      const controlled = [...inner.live];
      inner.live.clear();
      teardown(inner);
      for (const element of controlled) {
        for (const entry of core.elements.get(element)?.values() ?? []) if (entry.state === inner) entry.state = state;
        state.live.add(element);
      }
    }
    core.roots.set(root, state);
    for (const [name, spec] of core.specs) if (spec.global) installGlobal(state, name, spec);
  }
  scan(root, state);
  if (observe && !state.observer) startObserver(state);
  const owner = state;
  let held = true;
  return {
    destroy() {
      if (!held) return;
      held = false;
      if (core.roots.get(owner.root) !== owner) return;
      owner.holders -= 1;
      if (owner.holders <= 0) teardown(owner);
    },
  };
}

/**
 * Destroys every controller in `root` (itself included) at once, and takes
 * down the roots of init() at or inside it (their globals and observers).
 * @param {Document|Element|ShadowRoot} [root]
 */
export function destroy(root = globalThis.document) {
  if (!isNode(root)) return;
  for (const state of [...core.roots.values()]) if (state.root === root || holds(root, state.root)) teardown(state);
  for (const state of [...core.roots.values()]) {
    for (const element of [...state.live]) if (element === root || holds(root, element)) detachAll(element, state);
  }
}

/* ── Events ─────────────────────────────────────────── */

/**
 * Dispatches the bubbling CustomEvent `ds:<type>` on `el` with `detail`;
 * cancelable only when asked (never where cancelling could trap someone).
 * Returns false when a listener called preventDefault().
 * @param {EventTarget} el
 * @param {string} type
 * @param {any} [detail]
 * @param {{ cancelable?: boolean }} [options]
 * @returns {boolean}
 */
export function emit(el, type, detail, options = {}) {
  const name = String(type).startsWith('ds:') ? String(type) : `ds:${type}`;
  const View = el?.ownerDocument?.defaultView ?? globalThis;
  const Custom = View.CustomEvent ?? globalThis.CustomEvent;
  return el.dispatchEvent(new Custom(name, { bubbles: true, cancelable: Boolean(options?.cancelable), detail: detail ?? null }));
}

/* ── Config and strings ─────────────────────────────── */

/** The strings config() returns, kept until they change: `{ of: the settings, version, strings }`. */
let frozenStrings = null;

/**
 * Sets the page's locale and overrides strings (a `null` string restores
 * the default; `locale: null` the default locale), and returns the
 * settings now in force: `{ locale, strings }`. A change dispatches a
 * bubbling ds:config on the document with them, plus `changed`: what changed
 * ('locale', 'strings').
 * @param {{ locale?: string|null, strings?: Record<string, string|((vars: Record<string, any>) => string)|null> }} [options]
 * @returns {{ locale: string, strings: Readonly<Record<string, any>> }}
 */
export function config(options) {
  const settings = core.settings;
  const doc = globalThis.document;
  const lang = doc?.documentElement?.lang;
  const localeNow = () => settings.locale ?? (lang || globalThis.navigator?.language || 'en');
  const before = localeNow();
  const changed = [];
  if (options && typeof options === 'object') {
    if ('locale' in options) settings.locale = options.locale ? String(options.locale) : null;
    if (localeNow() !== before) changed.push('locale');
    const texts = Object.entries(options.strings ?? {});
    for (const [key, value] of texts) {
      if (value === null || value === undefined) delete settings.strings[key];
      else settings.strings[key] = typeof value === 'function' ? value : String(value);
    }
    if (texts.length) {
      changed.push('strings');
      settings.version = (settings.version ?? 0) + 1;
    }
  }
  // Read on every format and label: the merged strings are copied once per change, not on every read. The version
  // sits in the shared settings, so a change through another copy of this module counts too.
  if (!frozenStrings || frozenStrings.of !== settings || frozenStrings.version !== (settings.version ?? 0)) {
    frozenStrings = { of: settings, version: settings.version ?? 0, strings: Object.freeze({ ...DEFAULT_STRINGS, ...settings.strings }) };
  }
  const current = Object.freeze({ locale: localeNow(), strings: frozenStrings.strings });
  if (changed.length && typeof doc?.dispatchEvent === 'function') emit(doc, 'config', { ...current, changed });
  return current;
}

/**
 * The system's string `key` (the page's override, else the English
 * default, else the key itself), with {name} placeholders filled from
 * `vars`.
 * @param {string} key
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  const own = core.settings.strings;
  const text = Object.hasOwn(own, key) ? own[key] : Object.hasOwn(DEFAULT_STRINGS, key) ? DEFAULT_STRINGS[key] : key;
  const values = vars ?? {};
  const value = typeof text === 'function' ? text(values) : text;
  return String(value).replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));
}

/* ── Links from data ────────────────────────────────── */

/** The schemes a link from data may have: none runs script. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * `value` (a string or URL) when it is safe as an href or a navigation
 * from data: an absolute URL on http, https, mailto or tel, or a relative
 * one (no scheme of its own: a path, a query, a #fragment). Otherwise
 * (javascript:, data:, blob:, vbscript:, nothing) null. The scheme is read
 * by the URL parser, so tabs, newlines and leading spaces cannot hide it.
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeHref(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text.trim()) return null;
  let absolute = null;
  try {
    absolute = new URL(text);
  } catch {
    // No scheme of its own: relative to the page, so on the page's own scheme.
    return text;
  }
  return SAFE_SCHEMES.has(absolute.protocol) ? text : null;
}
