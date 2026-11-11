/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.notifications (js/notifications.js): the notification centre. */

export interface NotificationAction {
  id?: string;
  label: string;
  /** Runs after ds:action. */
  run?: (item: NotificationItem, centre: NotificationCentre) => void;
}

export interface NotificationItem {
  id: string;
  title: string;
  text?: string;
  /** A Date, a timestamp or an ISO text: shown as a relative time, kept current. */
  time?: Date | number | string | null;
  read?: boolean;
  /** A glyph of DS.icons (default info). */
  icon?: string;
  tone?: 'info' | 'success' | 'warning' | 'error' | 'primary' | 'neutral';
  /** The title links here; following it marks the notification read. */
  href?: string;
  /** A heading of its own instead of the day. */
  group?: string;
  actions?: NotificationAction[];
}

export interface NotificationCentre {
  get(): NotificationItem[];
  set(items: NotificationItem[]): void;
  /** New notifications at the top; announced unless `announce: false`. */
  add(items: NotificationItem | NotificationItem[], options?: { announce?: boolean }): void;
  update(id: string, patch: Partial<NotificationItem>): void;
  remove(id: string): void;
  read(id: string, read?: boolean): void;
  readAll(): void;
  /** How many are unread. */
  unread(): number;
  open(options?: { opener?: Element | null }): Promise<void>;
  close(): Promise<void>;
  refresh(): void;
  on(type: 'change', fn: (detail: { items: NotificationItem[]; unread: number }) => void): () => void;
  on(type: 'read', fn: (detail: { ids: string[]; read: boolean }) => void): () => void;
  on(type: 'action', fn: (detail: { item: NotificationItem; action: NotificationAction }) => void): () => void;
  on(type: 'select', fn: (detail: { item: NotificationItem }) => void): () => void;
  destroy(): void;
}

/** The day group of a time seen from `now`. */
export declare function dayOf(value: Date | number | string | null | undefined, now?: Date | number): 'today' | 'yesterday' | 'earlier';
/** Notifications in groups (their own group, else the day), newest first. */
export declare function groupByDay<N extends { time?: Date | number | string | null; group?: string | null }>(items: N[], options?: { now?: Date | number }): { key: string; day: boolean; items: N[] }[];
/** The centre of a .ds-sheet.ds-notifications (the same one data-ds-notifications makes). */
export declare function create(el: Element, options?: { items?: NotificationItem[]; bell?: Element | Element[] }): NotificationCentre;
/** Opens the centre of `el` through DS.overlay. */
export declare function open(el: Element, options?: { opener?: Element | null }): Promise<void>;
/** Closes the centre of `el` through DS.overlay. */
export declare function close(el: Element): Promise<void>;
