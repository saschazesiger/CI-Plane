/**
 * Types of DS.icons (js/icons.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 * A glyph is inner SVG markup on a 24px grid (docs/icons.md, glyph table).
 */

/** Default size in px: 20; 16 in buttons, chips, meta rows and status lines. */
export declare const ICON_SIZE: number;

/** SVG markup of a glyph; throws for anything that is not a glyph of this module. */
export declare function icon(body: string, size?: number, className?: string): string;
/** The same as an element, created in `doc` (default: document). */
export declare function iconElement(body: string, size?: number, className?: string, doc?: Document): SVGSVGElement;
/**
 * Fills every [data-icon] under `root` with its glyph (data-icon-size px, default 20); returns how many got a new
 * one. The glyph replaces the content; with data-icon-place="start" or "end" it goes first or last and the content
 * stays.
 */
export declare function fill(root?: Document | Element | DocumentFragment): number;

/* ── Glyphs ── */
export declare const arrowRight: string;
export declare const arrowLeft: string;
export declare const arrowUp: string;
export declare const arrowDown: string;
export declare const chevronDown: string;
export declare const chevronUp: string;
export declare const chevronRight: string;
export declare const chevronLeft: string;
export declare const chevronFirst: string;
export declare const chevronLast: string;
export declare const cornerDownLeft: string;
export declare const external: string;
export declare const plus: string;
export declare const close: string;
export declare const minimize: string;
export declare const menu: string;
export declare const moreVertical: string;
export declare const moreHorizontal: string;
export declare const grip: string;
export declare const search: string;
export declare const filter: string;
export declare const sort: string;
export declare const compose: string;
export declare const pencil: string;
export declare const save: string;
export declare const reset: string;
export declare const sync: string;
export declare const undo: string;
export declare const history: string;
export declare const copy: string;
export declare const download: string;
export declare const upload: string;
export declare const clipboard: string;
export declare const paperclip: string;
export declare const printer: string;
export declare const play: string;
export declare const pause: string;
export declare const stopCircle: string;
export declare const trash: string;
export declare const archive: string;
export declare const logout: string;
export declare const chat: string;
export declare const send: string;
export declare const bell: string;
export declare const mic: string;
export declare const micOff: string;
export declare const volume: string;
export declare const mail: string;
export declare const phone: string;
export declare const globe: string;
export declare const link: string;
export declare const flag: string;
export declare const thumbUp: string;
export declare const thumbDown: string;
export declare const check: string;
export declare const checkCircle: string;
export declare const alert: string;
export declare const alertCircle: string;
export declare const info: string;
export declare const helpCircle: string;
export declare const eye: string;
export declare const eyeOff: string;
export declare const clock: string;
export declare const ban: string;
export declare const calendar: string;
export declare const activity: string;
export declare const wifi: string;
export declare const wifiOff: string;
export declare const home: string;
export declare const panelLeft: string;
export declare const keyboard: string;
export declare const terminal: string;
export declare const tag: string;
export declare const sun: string;
export declare const moon: string;
export declare const overview: string;
export declare const apps: string;
export declare const list: string;
export declare const columns: string;
export declare const rows: string;
export declare const barChart: string;
export declare const settings: string;
export declare const cpu: string;
export declare const lock: string;
export declare const key: string;
export declare const shield: string;
export declare const user: string;
export declare const users: string;
export declare const userPlus: string;
export declare const userOff: string;
export declare const ticket: string;
export declare const file: string;
export declare const fileText: string;
export declare const fileCode: string;
export declare const folder: string;
export declare const box: string;
export declare const building: string;
export declare const mapPin: string;
export declare const laptop: string;
export declare const monitor: string;
export declare const hardDrive: string;
export declare const server: string;
export declare const graduationCap: string;
export declare const presentation: string;
export declare const camera: string;
export declare const video: string;
export declare const image: string;
export declare const leaf: string;
export declare const wrench: string;
export declare const sparkles: string;
