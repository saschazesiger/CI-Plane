/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.composer (src/components/composer/composer.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export interface ComposerOptions {
  /** Remember the draft under this key (DS.store, namespace "composer"). */
  draft?: string | null;
  /** What Enter does; default: send where the device has a fine pointer, else a new line. */
  enter?: 'send' | 'newline' | null;
  /** Start busy: the submit button is Stop. */
  busy?: boolean;
}

export interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
}

export interface ComposerSend {
  text: string;
  attachments: ComposerAttachment[];
  /** The mentions chosen from a palette whose text is still in the message. */
  mentions: { value: string; id: string }[];
  /** The command chosen from the "/" palette that starts the message, or null. */
  command: string | null;
}

export interface ComposerPick {
  value: string;
  id: string;
  option: Element;
}

export interface ComposerState {
  text: string;
  attachments: ComposerAttachment[];
  busy: boolean;
}

export interface ComposerController {
  get(): ComposerState;
  set(value: string | { text?: string; busy?: boolean; attachments?: File[] }): void;
  on(type: 'send', fn: (detail: ComposerSend) => void): () => void;
  on(type: 'stop', fn: (detail: {}) => void): () => void;
  on(type: 'attach', fn: (detail: { files: File[]; attachments: ComposerAttachment[] }) => void): () => void;
  on(type: 'remove', fn: (detail: { attachment: ComposerAttachment }) => void): () => void;
  on(type: 'command' | 'mention', fn: (detail: ComposerPick) => void): () => void;
  on(type: 'query', fn: (detail: { trigger: string; query: string }) => void): () => void;
  /** Sends what is in the field now; the detail, or null when nothing went (empty, busy, prevented). */
  send(): ComposerSend | null;
  /** Adds files as attachments; returns them. */
  add(files: Iterable<File> | ArrayLike<File>): ComposerAttachment[];
  /** Removes an attachment by its id. */
  remove(id: string): void;
  focus(): void;
  /** Reads the attributes again, those named or all (the attribute path calls it with the changed ones). */
  update(names?: string[]): void;
  destroy(): void;
}

/** The word a palette serves as the caret stands ("/" only at the start of the message), or null. */
export declare function query(text: string, caret: number, triggers?: string[]): { trigger: string; query: string; start: number; end: number } | null;
/** A composer driven from the page. */
export declare function create(el: Element, options?: ComposerOptions): ComposerController;
