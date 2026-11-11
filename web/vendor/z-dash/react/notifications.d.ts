/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Notifications> (react/notifications.js), generated from src/components/notifications/. */
import type { BehaviourComponent, OverlayProps } from './shared.js';

export type NotificationsVariant = never;

export interface NotificationsEvents {
  /** ds:action on the root. */
  onDsAction?: (event: CustomEvent) => void;
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:open on the root. */
  onDsOpen?: (event: CustomEvent) => void;
  /** ds:read on the root. */
  onDsRead?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface NotificationsOptions {
}

export declare const Notifications: BehaviourComponent<'dialog', NotificationsVariant, NotificationsEvents & NotificationsOptions & OverlayProps, ReturnType<typeof import('../js/notifications.js').create>>;
