/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Launcher> (react/launcher.js), generated from src/components/shell/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type LauncherVariant = never;

export interface LauncherEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LauncherOptions {
}

export declare const Launcher: BehaviourComponent<'div', LauncherVariant, LauncherEvents & LauncherOptions, Controller>;
