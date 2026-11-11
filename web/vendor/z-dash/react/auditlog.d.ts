/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <AuditLog> (react/auditlog.js), generated from src/components/auditlog/. */
import type { BehaviourComponent } from './shared.js';

export type AuditLogVariant = never;

export interface AuditLogEvents {
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
  /** ds:render on the root. */
  onDsRender?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface AuditLogOptions {
}

export declare const AuditLog: BehaviourComponent<'section', AuditLogVariant, AuditLogEvents & AuditLogOptions, ReturnType<typeof import('../js/auditlog.js').create>>;
