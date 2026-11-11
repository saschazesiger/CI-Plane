/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <ShortcutSheet> (react/shortcuts.js), generated from src/components/shortcuts/. */
import type { BehaviourComponent, OverlayProps } from './shared.js';

export type ShortcutSheetVariant = 'bottom' | 'contained' | 'full' | 'full-narrow' | 'lg' | 'scroll-outside' | 'sm' | 'xl';

export interface ShortcutSheetEvents {
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
  /** ds:open on the root. */
  onDsOpen?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ShortcutSheetOptions {
}

export declare const ShortcutSheet: BehaviourComponent<'dialog', ShortcutSheetVariant, ShortcutSheetEvents & ShortcutSheetOptions & OverlayProps, ReturnType<typeof import('../js/shortcuts.js').create>>;
