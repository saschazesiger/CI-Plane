/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <CommandPalette> (react/command.js), generated from src/components/command/. */
import type { BehaviourComponent, OverlayProps } from './shared.js';

export type CommandPaletteVariant = 'bottom' | 'contained' | 'full' | 'full-narrow' | 'lg' | 'scroll-outside' | 'sm' | 'xl';

export interface CommandPaletteEvents {
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:open on the root. */
  onDsOpen?: (event: CustomEvent) => void;
  /** ds:query on the root. */
  onDsQuery?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface CommandPaletteOptions {
}

export declare const CommandPalette: BehaviourComponent<'dialog', CommandPaletteVariant, CommandPaletteEvents & CommandPaletteOptions & OverlayProps, ReturnType<typeof import('../js/command.js').create>>;
