import type { BoardKind } from '../model/kinds';
import type { Tool } from '../model/store';
import type { Node } from '../model/types';
import { isSharedSrc } from './pictureRef';

/**
 * What a shared board takes so far: the kinds of node it holds, what of a node is changed there, and
 * which other edits it takes. What it does not take yet is turned away when asked for (see
 * target.ts), not offered on screen (see useTakes in model/store.ts), and never read off the drawing
 * as an edit (see editBetween). Kept apart from Yjs so that the app's first load does not carry it.
 */

/** The kinds of node a shared board holds: sequence diagrams are not shared yet. */
const SHARED_TYPES = ['shape', 'sticky', 'text', 'frame', 'device', 'junction', 'legend', 'image'] as const;
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
  image: ['src', 'under', 'opacity', 'captionAt', 'fontSize'],
} as const satisfies Record<SharedType, readonly string[]>;
export type Attribute = (typeof ATTRIBUTES)[SharedType][number];

/**
 * Besides every node's text, what a node holds that is typed by hand (a device's note, a legend's row
 * names). Written whole only when the node is put on the board: a whole new text put in place of one
 * someone else is typing into would lose their letters. Afterwards it is changed only by typing into
 * it (see typing.ts), as the board does with a node's text and a line's label; the inspector's
 * fields do not yet (see `fields`). A port's name and a line's texts (LINE_TEXTS) are kept the same way.
 */
export const WRITTEN_ONCE: Partial<Record<SharedType, readonly string[]>> = {
  device: ['note'],
  legend: ['names'],
  image: ['caption'],
};

/**
 * Whether a shared board can hold a node as it stands: a picture only as one of the project's (see
 * pictureRef.ts), never one held inside the board or kept on this machine, which no one else could see.
 */
export const holdable = (n: Node): boolean => n.type !== 'image' || isSharedSrc(n.src);

/** What of a device's port is changed on a shared board: each set whole. Its name is written once (see WRITTEN_ONCE); its place among the ports is changed as an order (see order.ts). */
export const PORT_ATTRIBUTES = ['side', 'signal'] as const;

/**
 * What a line holds besides its two ends (changed together) and its texts: what its cable is, how
 * it is drawn and labelled, and the bends laid by hand (`route`; without it, each screen routes the
 * line itself). Each changed on its own, set whole.
 */
export const LINE_ATTRIBUTES = ['signal', 'length', 'arrow', 'dash', 'cableId', 'showId', 'showLength', 'stacked', 'showProtocol', 'spec', 'maker', 'model', 'url', 'color', 'fontSize', 'labelAt', 'route', 'tidied', 'tag'] as const;
export type LineAttribute = (typeof LINE_ATTRIBUTES)[number];

/** A line's texts typed by hand: written once, as a node's (see WRITTEN_ONCE). */
export const LINE_TEXTS = ['label', 'note'] as const;

/**
 * An edit a board can be asked for besides changing its nodes: picking a tool, typing text in on the
 * board (`typing`), typing into the inspector's fields (`fields`: names, notes, a port's name, each
 * set whole as typed), making copies (duplicating, pasting), the order things are drawn or listed in
 * (nodes, a device's ports), the board's settings, pictures, a device being one with devices on
 * other boards (or software running on one), tidying the board up, comments, and taking the board off.
 */
export type EditKind = Tool | 'typing' | 'fields' | 'copying' | 'restack' | 'settings' | 'images' | 'links' | 'tidy' | 'comments' | 'removing';

/** What a shared board does not take yet. */
const NOT_YET: ReadonlySet<EditKind> = new Set<EditKind>(['sequence', 'fields', 'settings', 'links', 'tidy']);

/** Whether the app runs in the desktop app, as main.tsx tells. */
const inDesktopApp = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Whether a shared board takes an edit of this kind. Not pictures in the desktop app yet (#25): it
 * reaches the server by WebSocket only, so one put there would never be sent.
 */
export const sharedTakes = (what: EditKind): boolean => !NOT_YET.has(what) && !(what === 'images' && inDesktopApp());

/** What a shared project with no board takes: looking round, nothing to draw on. */
export const emptyTakes = (what: EditKind): boolean => what === 'select' || what === 'pan';

/** The kinds of board a shared project is given: a sequence board's diagram is not shared yet. */
export const SHARED_KINDS: readonly BoardKind[] = ['system', 'software', 'free'];

/** The above as the screen says it, and what it says when a shared board turns an edit away. */
export const NOT_TAKEN = '共有中のボードでは、まだこの編集はできません';
export const SHARED_SO_FAR = '図形・テキスト・機材・画像を置く・動かす・色などを変える・消す・複製する・貼り付ける操作と、ボードの上での文字の入力、線・ポートの追加・つなぎ替え・削除、重なり順とポート・表の並び順';
export const NOT_SHARED_YET = 'インスペクタでの名前やメモなどの入力、ボードの設定';
