/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.core (js/core.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 */

/** The page's one runtime (globalThis.ZDash.runtime), shared by every copy. */
export interface Runtime {
  /** The shared state `name`, made by `init` (a function, or the value itself) the first time any copy asks. */
  state<T = any>(name: string, init?: (() => T) | T): T;
}

/** What a behaviour's init() gets besides its element. */
export interface BehaviourContext {
  /** The behaviour's name. */
  readonly name: string;
  /** The root of init() that found the element. */
  readonly root: Document | Element | ShadowRoot;
  /** Aborts when the controller is destroyed: pass it to addEventListener. */
  readonly signal: AbortSignal | null;
  /** emit(el, ...) on the element. */
  emit(type: string, detail?: unknown, options?: EmitOptions): boolean;
  /** The system's string `key`. */
  t(key: string, vars?: Record<string, unknown>): string;
}

/** A controller: at least destroy(); update(names) is called on a change of an observed attribute. */
export interface Controller {
  destroy(): void;
  update?(names: string[]): void;
  [key: string]: any;
}

export interface BehaviourSpec {
  /** The data-ds-* attribute that marks an element. */
  attribute?: string;
  /** Instead of (or besides) the attribute: the selector of the elements. */
  selector?: string;
  /** Called once per matching element: a controller, a cleanup function or nothing. */
  init?(el: Element, ctx: BehaviourContext): Controller | (() => void) | void;
  /** Installed once per root of init() (a delegated behaviour); returns a cleanup. */
  global?(root: Document | Element | ShadowRoot): (() => void) | { destroy(): void } | void;
  /** More attributes to observe (options of the behaviour); never one the controller writes. */
  attributes?: string[];
}

export interface InitOptions {
  /** Keep initialising added and changed elements and destroying removed ones (default true). */
  observe?: boolean;
}

export interface InitHandle {
  /** Lets go of this hold on the root; the last one takes it down (globals, observer, controllers). */
  destroy(): void;
}

export interface EmitOptions {
  /** Whether preventDefault() can cancel it (default false). */
  cancelable?: boolean;
}

/** A string, or a function of the placeholders (plurals). */
export type Text = string | ((vars: Record<string, any>) => string);

export interface ConfigOptions {
  /** The page's locale; null goes back to <html lang>, else the browser's. */
  locale?: string | null;
  /** Overrides of the system's texts by key; null restores the default. */
  strings?: Record<string, Text | null>;
}

export interface Settings {
  readonly locale: string;
  readonly strings: Readonly<Record<string, Text>>;
}

/** The detail of ds:config, dispatched on the document when config() changed something. */
export interface ConfigDetail extends Settings {
  /** What changed: another locale in force, or strings given. */
  readonly changed: ReadonlyArray<'locale' | 'strings'>;
}

/** What manage() returns: the controller of one element whose owner renders it. */
export interface ManagedHandle {
  /** The controller (null when init() returned a function or nothing, or once destroyed). */
  readonly controller: Controller | null;
  /** After the owner changed the element's attributes: the controller's update(names), else a fresh controller. */
  update(): void;
  /** Destroys the controller; safe to call twice. */
  destroy(): void;
}

/** The runtime of the page. */
export declare const runtime: Runtime;
/** Adds a behaviour by name; false when a copy loaded earlier defined it. */
export declare function define(name: string, spec: BehaviourSpec): boolean;
/** The controller of `el` for the behaviour `name` (without one: its first), or null. */
export declare function get(el: Element, name?: string): Controller | null;
/** Runs the behaviour `name` on `el` for an owner that renders it (the React adapter, inside [data-ds-managed]); null when no such behaviour initialises elements. */
export declare function manage(el: Element, name: string): ManagedHandle | null;
/** Installs every global behaviour on `root` and initialises its elements (observing them by default). */
export declare function init(root?: Document | Element | ShadowRoot, options?: InitOptions): InitHandle;
/** Destroys every controller in `root` at once, and the roots of init() at or inside it. */
export declare function destroy(root?: Document | Element | ShadowRoot): void;
/** Dispatches the bubbling CustomEvent `ds:<type>`; false when a listener called preventDefault(). */
export declare function emit(el: EventTarget, type: string, detail?: unknown, options?: EmitOptions): boolean;
/** Sets the locale and overrides strings; returns the settings in force. A change dispatches ds:config on the document (ConfigDetail). */
export declare function config(options?: ConfigOptions): Settings;
/** The system's string `key`, with {name} placeholders from `vars`. */
export declare function t(key: string, vars?: Record<string, unknown>): string;
/** `value` when it is safe as an href from data (http, https, mailto, tel or relative), else null. */
export declare function safeHref(value: unknown): string | null;
