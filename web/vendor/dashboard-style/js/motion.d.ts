/**
 * Types of DS.motion (js/motion.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 * Durations are ms, read from the computed tokens (--ds-time-scale included).
 */

/** A handle that lets go of what the call set up. */
export interface Destroyable {
  destroy(): void;
}

/** The ms of every --ds-dur-*, --ds-delay-* and --ds-hold-*, the cubic of every --ds-ease-*, by token name. */
export declare const MOTION_FALLBACKS: Readonly<Record<string, number | string>>;
/** --ds-delay-loader outside a theme (ms). */
export declare const LOADER_DELAY_MS: number;
/** --ds-hold-loader outside a theme (ms). */
export declare const LOADER_MIN_VISIBLE_MS: number;
/** Highest stagger index (0 to 5). */
export declare const STAGGER_MAX: number;
/** --ds-dur-glide outside a theme (ms): how long countUp() counts. */
export declare const COUNT_UP_MS: number;

/** A duration token as computed on `element`, in ms (e.g. '--ds-dur-medium'). */
export declare function motionDuration(element: Element | null | undefined, token: string): number;
/** An easing token as computed on `element` (e.g. '--ds-ease-spatial'). */
export declare function motionEasing(element: Element | null | undefined, token: string): string;
/** The duration of a travel of `px` pixels, in ms. */
export declare function travelDuration(element: Element | null | undefined, px: number): number;
/** Restarts the scroll-driven animations of scrollers that may have shrunk, as on a fresh load; resolves to how many. */
export declare function resyncScroll(root?: Element | Document): Promise<number>;

/** Numbers the items of a list for staggered entrances (--ds-i); `max` caps the index. */
export declare function stagger(elements: Iterable<Element>, options?: { from?: number; max?: number }): void;
/** Removes and re-adds classes so their animation plays again. */
export declare function replay(element: Element | null | undefined, ...classNames: string[]): void;

export interface SettledOptions {
  names?: string[];
  property?: string;
  transitions?: boolean;
  subtree?: boolean;
  timeout?: number;
  event?: 'animationend' | 'transitionend';
}
/** Resolves once the element's own finite animations (and transitions, if asked) finished. */
export declare function settled(element: Element | null | undefined, options?: SettledOptions): Promise<void>;

/** The variants of enter(); 'fill-x' and 'fill-y' are deprecated (use 'fill'). */
export type EnterVariant = '' | 'fade' | 'scale' | 'slide' | 'swap' | 'delayed' | 'pop' | 'fill' | 'fill-x' | 'fill-y';
export type LeaveVariant = '' | 'sink' | 'scale' | 'slide' | 'pop';

/** Plays an entrance (.ds-enter); resolves without acting once a later call took over. */
export declare function enter(element: Element | null | undefined, variant?: EnterVariant): Promise<void>;
/** Plays an exit (.ds-leave), then removes, hides or keeps the element. */
export declare function leave(
  element: Element | null | undefined,
  variant?: LeaveVariant,
  options?: { then?: 'remove' | 'hide' | 'keep'; focus?: Element | (() => Element | null) | null },
): Promise<void>;
/** Stops enter() or leave() where it is. */
export declare function cancel(element: Element | null | undefined): void;
/** enter() for several elements, staggered by default. */
export declare function enterAll(
  elements: Iterable<Element>,
  variant?: EnterVariant,
  options?: { stagger?: boolean; max?: number; visibleOnly?: boolean },
): Promise<void>;
/** Staggers the children of `container` in once (data-ds-staggered). */
export declare function staggerOnce(container: Element | null | undefined, options?: { variant?: EnterVariant; max?: number }): Promise<void>;

export interface LoaderOptions {
  element?: Element | null;
  delay?: number;
  minVisible?: number;
}
/** How long a loader shown since `startedAt` (Date.now()) still has to stay, in ms. */
export declare function loaderHoldMs(startedAt: number, now?: number, options?: LoaderOptions): number;
/** Resolves once a loader shown since `startedAt` may go. A numeric second argument is deprecated (use `{ now }`). */
export declare function settleLoader(startedAt: number, options?: (LoaderOptions & { now?: number }) | number, legacy?: LoaderOptions): Promise<void>;
/** The documented refresh: the loading bar over `container` while `load` runs. */
export declare function refresh<T>(container: Element | null | undefined, load: () => T | PromiseLike<T>, options?: { signal?: AbortSignal; loadbar?: boolean }): Promise<T>;

/** Blocks user input on busy, done and aria-disabled actions under `root`. */
export declare function guard(root?: Document | ShadowRoot): Destroyable;
/** Sets a button's label, keeping its icons and faces; while busy() runs it waits for the rest face. */
export declare function setLabel(button: Element | null | undefined, text: string): void;
/** Shows a button busy while `work` runs, then its done face when it has one. */
export declare function busy<T>(button: Element | null | undefined, work: (() => T | PromiseLike<T>) | PromiseLike<T> | T, options?: { done?: boolean }): Promise<T>;

export interface CountUpHandle {
  /** Writes the final value at once. */
  cancel(): void;
  finished: Promise<void>;
}
/** Counts the element's text from the shown value to `to`. */
export declare function countUp(
  element: Element | null | undefined,
  to: number,
  options?: { from?: number; format?: (value: number) => string; duration?: number; win?: any },
): CountUpHandle;

/** Writes where a popup grows from; `side` is where the panel lies from the trigger. */
export declare function originFrom(trigger: Element | { x: number; y: number }, panel: Element): { origin: string; side: 'bottom' | 'top' | 'right' | 'left' };
/** Rolls a .ds-swap slot to new text. */
export declare function roll(element: Element | null | undefined, text: string, options?: { hold?: boolean }): Promise<void>;
/** Crossfades a .ds-swap slot (or a .ds-icon-swap) to new content. */
export declare function crossfade(element: Element | null | undefined, next: Node | string, options?: { kind?: 'text' | 'icon' }): Promise<void>;

/** What flip() passes to its mutate callback; hand it straight to DS.dom.morphHtml(). */
export interface FlipMutateOptions {
  holdOrder: boolean;
  onInsert: (node: Node) => void;
  onRemove: (node: Node) => Promise<void> | undefined;
  onKeep?: (kept: Element, template: Element) => void;
}
export interface FlipOptions {
  items?: string;
  live?: boolean;
  max?: number;
  hold?: number;
  refocus?: boolean | Element | (() => Element | null);
  onKeep?: (kept: Element, template: Element) => void;
}
/** Runs `mutate`, then glides the items of `container` from their old places. */
export declare function flip(container: Element | null | undefined, mutate: (options: FlipMutateOptions) => void, options?: FlipOptions): Promise<void>;

export interface SortableOptions {
  items?: string;
  handle?: string;
  onChange?: (order: Element[], before: Element[]) => void;
  announce?: (index: number, count: number) => string;
}
/** Reorders the items of `list` by dragging their grip or with the keyboard. */
export declare function sortable(list: Element | null | undefined, options?: SortableOptions): Destroyable;

export interface TransitionOptions {
  type?: 'fade-through' | 'forward' | 'back' | 'container';
  from?: Element | null;
  focus?: boolean | ((incoming: Element | null) => Element | null);
}
/** A navigation through View Transitions (the update runs at once without them). */
export declare function transition(
  update: () => Element | null | undefined | void | Promise<Element | null | undefined | void>,
  options?: TransitionOptions,
): Promise<void>;
