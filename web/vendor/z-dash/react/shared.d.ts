/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of the React adapter's shared part (react/shared.js) and of the
 * props every adapter component shares. Hand-written; test/react.test.js
 * keeps the declared exports equal to the module's.
 */
import type * as React from 'react';
import type { ManagedHandle } from '../js/core.js';

export type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type Density = 'comfortable' | 'compact' | 'dense' | 'tight';
export type Shape = 'square' | 'soft' | 'default' | 'round';
export type Tone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error';

/** The option classes (docs/options.md): on the element, they reach everything inside it. */
export interface OptionProps {
  /** .ds-xs ... .ds-xl. */
  size?: Size;
  /** .ds-density-*. */
  density?: Density;
  /** .ds-shape-*. */
  shape?: Shape;
  /** .ds-tone-*: only where the component shows a meaning, always with an icon or a word. */
  tone?: Tone;
  /** .ds-touch: at least the touch target, whatever the size and density. */
  touch?: boolean;
}

/** A controller of a behaviour: get(), set(value), on(type, fn), destroy() and its own methods. */
export interface Controller {
  destroy(): void;
  [key: string]: any;
}

/** A handler of ds:<type> as an onDs<Type> prop. */
export type DsEventHandler<Detail = any> = (event: CustomEvent<Detail>) => void;

/** onDs<Type> props for any ds:<type> event of the component. */
export type DsEventProps = { [key: `onDs${string}`]: DsEventHandler | undefined };

export type IntrinsicTag = keyof React.JSX.IntrinsicElements;

/** The props of a component made by behaviour(). */
export type BehaviourProps<Tag extends IntrinsicTag, Variant extends string, Extra, C> =
  Omit<React.ComponentPropsWithoutRef<Tag>, 'className' | keyof Extra> & OptionProps & DsEventProps & Extra & {
    /** Another element than the documented one (keep its role and markup). */
    as?: IntrinsicTag;
    /** The modifiers of the component's block: one, or a list. */
    variant?: Variant | Variant[];
    className?: string;
    /** Receives the controller once it runs (null when it goes). */
    controllerRef?: React.Ref<C | null>;
  };

export type BehaviourComponent<Tag extends IntrinsicTag, Variant extends string, Extra, C = Controller> =
  React.ForwardRefExoticComponent<BehaviourProps<Tag, Variant, Extra, C> & React.RefAttributes<React.ElementRef<Tag>>>;

/** The close reasons of DS.overlay. */
export type CloseReason = 'escape' | 'backdrop' | 'close' | 'submit' | 'confirm' | string;

/** The props of an overlay (a dialog, a sheet): open drives it, onClose reports a close the user asked for. */
export interface OverlayProps {
  /** Open (DS.overlay.open) or closed (DS.overlay.close). */
  open?: boolean;
  /** The user closed it (Escape, the backdrop, [data-ds-close], a submit): set open to false. */
  onClose?: (reason: CloseReason, event: CustomEvent<{ reason: CloseReason }>) => void;
  /** Where focus goes back on close (default: the element that had it on open). */
  opener?: Element | React.RefObject<Element | null> | null;
}

export interface BehaviourSpec {
  name: string;
  display: string;
  attribute: string;
  tag: string;
  classes?: string[];
  block?: string | null;
  role?: string | null;
  /** Option props and the attribute each becomes. */
  options?: Record<string, string> | null;
  /** How the content of a behaviour that writes it itself goes in (names.json). */
  content?: { mode: 'set' | 'reinit' | 'attribute' | 'none'; prop?: string; attribute?: string } | null;
  overlay?: { open?: (element: Element, options?: any) => unknown; close?: (element: Element, options?: any) => unknown } | null;
}

export declare const useIsomorphicLayoutEffect: typeof React.useLayoutEffect;
export declare const SIZES: readonly Size[];
export declare const DENSITIES: readonly Density[];
export declare const SHAPES: readonly Shape[];
export declare const TONES: readonly Tone[];
export declare const MANAGED: 'data-ds-managed';

/** One class string from strings, arrays and falsy values. */
export declare function cx(...parts: any[]): string;
/** The option classes of size, density, shape, tone and touch. */
export declare function optionClasses(options?: OptionProps): string[];
/** The modifier classes of a block: modifiers('ds-btn', ['quiet', 'icon']). */
export declare function modifiers(block: string | null, variant: string | string[] | undefined | null): string[];
/** [the option props, the rest]. */
export declare function splitOptions<P extends object>(props: P): [OptionProps, Omit<P, keyof OptionProps>];
/** Sets a ref (a function or an object). */
export declare function setRef<T>(ref: React.Ref<T> | undefined, value: T): void;
/** One callback ref that sets every ref given. */
export declare function useMergedRef<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T>;
/** A lone text child as its own text node (the ripple's spans stay). */
export declare function textSafe(children: React.ReactNode): React.ReactNode;
/** The state classes the system writes on a root, kept across a className React writes. */
export declare const SYSTEM_CLASSES: readonly string[];
/** `className` plus the system's state classes the element carries now (.ds-pressed, .ds-btn--done ...). */
export declare function keepClasses(element: Element | null, className: string): string | undefined;
/** An option prop as its attribute's value: true → '', false/null/undefined → none, an object → JSON. */
export declare function optionValue(value: unknown): string | undefined;
/** The text of a content prop or of string children; null for none. */
export declare function contentText(value: unknown): string | null;
/** 'onDsBeforeClose' → 'before-close'; null for any other prop. */
export declare function eventType(prop: string): string | null;
/** 'before-close' → 'onDsBeforeClose'. */
export declare function eventProp(type: string): string;
/** [handlers by event type, the other props]. */
export declare function splitHandlers<P extends object>(props: P): [Record<string, DsEventHandler | undefined>, Partial<P>];
/** Listens to ds:<type> on the root for each handler (the component's own events). */
export declare function useDsEvents(elementRef: React.RefObject<Element | null>, handlers: Record<string, DsEventHandler | undefined>): void;
/** Runs the behaviour `name` on the element of the returned ref (DS.core.manage). */
export declare function useBehaviour(name: string, options?: {
  controllerRef?: React.Ref<any>;
  handlers?: Record<string, DsEventHandler | undefined>;
  /** The text of a behaviour that writes its element's content itself. */
  content?: { text: string | null; mode: 'set' | 'reinit' } | null;
}): React.MutableRefObject<any>;
/** Opens and closes an overlay root with `open` (DS.overlay or the module's open and close). */
export declare function useOverlay(elementRef: React.RefObject<Element | null>, open: boolean, options?: {
  onClose?: OverlayProps['onClose'];
  openWith?: (element: Element, options?: any) => unknown;
  closeWith?: (element: Element, options?: any) => unknown;
  opener?: OverlayProps['opener'];
}): void;

export interface IconProps {
  /** A glyph of js/icons.js (import { check } from '<dest>/js/icons.js'). */
  glyph: string;
  /** Width and height in px (default 20). */
  size?: number;
  className?: string;
}
/** An icon of js/icons.js as an <svg> (aria-hidden, no innerHTML). */
export declare function Icon(props: IconProps): React.ReactElement;
/** An icon prop as a node: a glyph string or any node. */
export declare function iconNode(icon: string | React.ReactNode | false | null | undefined, size?: number, className?: string): React.ReactNode;
/** The adapter component of one behaviour (the generated files call it). */
export declare function behaviour(spec: BehaviourSpec): BehaviourComponent<any, string, {}>;

export type { ManagedHandle };
