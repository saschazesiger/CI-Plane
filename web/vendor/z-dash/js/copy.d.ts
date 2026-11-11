/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.copy (js/copy.js). */

/** How a copy went: whether it worked, and through what. */
export interface CopyResult {
  ok: boolean;
  method: 'clipboard' | 'command' | 'none';
}

/** A copy button's controller: get() the text it copies, set(text) from the page. */
export interface CopyController {
  element: Element;
  get(): string;
  set(text: string | null): void;
  /** Copies now, as a press does (feedback, announcement, ds:copy). */
  copy(): Promise<CopyResult>;
  /** Shows the copied state for --ds-hold-status, without copying. */
  done(): void;
  /** 'copy' after every attempt: { text, ok, method }. Returns the unsubscribe. */
  on(type: 'copy', fn: (detail: CopyResult & { text: string }) => void): () => void;
  destroy(): void;
}

/** The text a copy button copies: data-ds-copy-value, else the target its data-ds-copy names, else the .ds-copy__value beside it. */
export declare function textOf(button: Element): string;
/** Copies `text`: the Clipboard API, else the copy command. Never rejects. */
export declare function copy(text: string, options?: { doc?: Document }): Promise<CopyResult>;
/** A copy button driven from the page; the controller data-ds-copy makes. */
export declare function create(button: Element, options?: { text?: string | null }): CopyController;
