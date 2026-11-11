import type { Tool } from '../model/store';

/**
 * What a shared board takes so far: the kinds of node it holds, what of a node is changed there, and
 * which other edits it takes. What it does not take yet is turned away when asked for (see
 * target.ts), not offered on screen (see useTakes in model/store.ts), and never read off the drawing
 * as an edit (see editBetween). Kept apart from Yjs so that the app's first load does not carry it.
 */

/** The kinds of node a shared board holds: pictures and sequence diagrams are not shared yet. */
const SHARED_TYPES = ['shape', 'sticky', 'text', 'frame', 'device', 'junction', 'legend'] as const;
export type SharedType = (typeof SHARED_TYPES)[number];

export const isShared = (type: unknown): type is SharedType => SHARED_TYPES.includes(type as SharedType);

/**
 * What a node holds besides its place and size, each changed on its own, set whole. `hidden` (a
 * legend's rows left out) is a set: rows shown or hidden by two people at once are both kept.
 */
export const ATTRIBUTES = {
  shape: ['shape', 'color', 'fontSize', 'bold', 'fill', 'dash'],
  sticky: ['color', 'done', 'at', 'fontSize', 'bold'],
  text: ['fontSize', 'bold'],
  frame: ['color', 'fontSize', 'bold'],
  device: ['maker', 'model', 'category', 'url', 'watts', 'capacity', 'color', 'qty', 'price', 'vendor', 'venue', 'ip', 'host'],
  junction: [],
  legend: ['devices', 'hidden'],
} as const satisfies Record<SharedType, readonly string[]>;
export type Attribute = (typeof ATTRIBUTES)[SharedType][number];

/**
 * Besides every node's text, what a node holds that is typed by hand (a device's note, a legend's row
 * names) or its ports. Written when the node is put on the board; not changed afterwards on a shared
 * board yet, since putting a whole new text in place of one being typed into by someone else would
 * lose their letters.
 */
export const WRITTEN_ONCE: Partial<Record<SharedType, readonly string[]>> = {
  device: ['note', 'ports'],
  legend: ['names'],
};

/**
 * An edit a board can be asked for besides changing its nodes: picking a tool, typing text in,
 * making copies (duplicating, pasting), the drawing order, lines, ports, the board's settings,
 * pictures, a device being one with devices on other boards (or software running on one), tidying
 * the board up, comments, and taking the board off.
 */
export type EditKind = Tool | 'typing' | 'copying' | 'restack' | 'lines' | 'ports' | 'settings' | 'images' | 'links' | 'tidy' | 'comments' | 'removing';

/** What a shared board does not take yet. A text box is nothing until text is typed into it. */
const NOT_YET: ReadonlySet<EditKind> = new Set<EditKind>(['sequence', 'text', 'typing', 'copying', 'restack', 'lines', 'ports', 'settings', 'images', 'links', 'tidy', 'comments', 'removing']);

/** Whether a shared board takes an edit of this kind. */
export const sharedTakes = (what: EditKind): boolean => !NOT_YET.has(what);

/** The above as the screen says it. */
export const SHARED_SO_FAR = '図形や機材を置く・動かす・色などを変える・消す操作';
export const NOT_SHARED_YET = '名前やメモなどの文字の入力、ポート、線、ボードの設定';
