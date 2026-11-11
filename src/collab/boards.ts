/**
 * The boards of a shared project (see model.ts for the Y.Doc's form): which there are, which are
 * deleted, and adding, renaming, deleting and restoring them. What a board holds is model.ts's.
 *
 * A board is never taken out of `boards`: deleting one adds a mark of its own to `deletions`, and
 * the board is deleted while any mark names it. Restoring it takes off the marks the restorer has
 * seen, so a delete made at the same time by someone else keeps it deleted: one key for every delete
 * would keep only one of two made at once, and a restore would then bring the board back or not by
 * the editors' client ids. An edit made on the board by someone who had not yet heard of the delete
 * changes what the board holds, not the marks, so it does not bring the board back either.
 */
import * as Y from 'yjs';
import type { BoardKind } from '../model/kinds';
import { boardKind } from '../model/load';
import type { Doc } from '../model/types';
import { uniqueId } from './id';

export interface SharedBoardInfo {
  id: string;
  title: string;
  kind: Doc['kind'];
}

const BOARDS = 'boards';
const DELETIONS = 'deletions';

type YBoard = Y.Map<unknown>;

/** A board of the project, deleted or not; null for an id the project never had. */
function yBoard(ydoc: Y.Doc, id: string): YBoard | null {
  const board = ydoc.getMap<unknown>(BOARDS).get(id);
  return board instanceof Y.Map ? board : null;
}
const deletions = (ydoc: Y.Doc): Y.Map<unknown> => ydoc.getMap<unknown>(DELETIONS);
/** The ids of the deleted boards. */
function deletedIds(ydoc: Y.Doc): Set<string> {
  const out = new Set<string>();
  deletions(ydoc).forEach((board) => typeof board === 'string' && out.add(board));
  return out;
}
const isDeleted = (ydoc: Y.Doc, id: string): boolean => deletedIds(ydoc).has(id);

const titleOf = (board: YBoard): string => {
  const title = board.get('title');
  return typeof title === 'string' ? title : '';
};
const infoOf = (id: string, board: YBoard): SharedBoardInfo => ({ id, title: titleOf(board), kind: boardKind(board.get('kind')) });

/** The project's boards, deleted ones or the others, in a fixed order (by title, then id) so every client lists them alike. */
function listBoards(ydoc: Y.Doc, deleted: boolean): SharedBoardInfo[] {
  const gone = deletedIds(ydoc);
  const out: SharedBoardInfo[] = [];
  ydoc.getMap<unknown>(BOARDS).forEach((board, id) => {
    if (board instanceof Y.Map && gone.has(id) === deleted) out.push(infoOf(id, board));
  });
  return out.sort((a, b) => a.title.localeCompare(b.title, 'ja') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The project's boards, the deleted ones left out. */
export const boardList = (ydoc: Y.Doc): SharedBoardInfo[] => listBoards(ydoc, false);

/** The project's deleted boards, which can be restored. */
export const deletedBoardList = (ydoc: Y.Doc): SharedBoardInfo[] => listBoards(ydoc, true);

/** A board of the project; null for one deleted, or not in the project. */
export function liveBoard(ydoc: Y.Doc, id: string): SharedBoardInfo | null {
  const board = yBoard(ydoc, id);
  return board && !isDeleted(ydoc, id) ? infoOf(id, board) : null;
}

/** The nodes a board holds, deleted or not: what is kept for a restore. Null for an id the project never had. */
export function boardNodes(ydoc: Y.Doc, id: string): Y.Map<unknown> | null {
  const nodes = yBoard(ydoc, id)?.get('nodes');
  return nodes instanceof Y.Map ? nodes : null;
}

/** Put a new board, holding no nodes yet, in the project, within the caller's transaction. Returns its nodes. */
export function putBoard(ydoc: Y.Doc, board: { id: string; title: string; kind: BoardKind }): Y.Map<unknown> {
  const y = new Y.Map<unknown>();
  const nodes = new Y.Map<unknown>();
  y.set('id', board.id);
  y.set('title', board.title);
  y.set('kind', board.kind);
  y.set('nodes', nodes);
  ydoc.getMap<YBoard>(BOARDS).set(board.id, y);
  return nodes;
}

/** Add an empty board to the project, under a new id, as one transaction under `origin`. Returns the id. */
export function addBoard(ydoc: Y.Doc, board: { title: string; kind: BoardKind }, origin: unknown): string {
  const id = uniqueId();
  ydoc.transact(() => putBoard(ydoc, { id, ...board }), origin);
  return id;
}

/** Rename a board of the project; a deleted board is left as it is. */
export function renameBoard(ydoc: Y.Doc, id: string, title: string, origin: unknown): void {
  const board = yBoard(ydoc, id);
  if (board && !isDeleted(ydoc, id) && titleOf(board) !== title) ydoc.transact(() => board.set('title', title), origin);
}

/** Mark a board deleted. What it holds is kept, for `restoreBoard`. */
export function deleteBoard(ydoc: Y.Doc, id: string, origin: unknown): void {
  if (yBoard(ydoc, id) && !isDeleted(ydoc, id)) ydoc.transact(() => deletions(ydoc).set(uniqueId(), id), origin);
}

/**
 * Take the delete marks seen here off a board. A delete made at the same time, by someone who had
 * not seen this, is not undone: the board stays deleted.
 */
export function restoreBoard(ydoc: Y.Doc, id: string, origin: unknown): void {
  const marks = [...deletions(ydoc).entries()].filter(([, board]) => board === id).map(([mark]) => mark);
  if (marks.length) ydoc.transact(() => marks.forEach((mark) => deletions(ydoc).delete(mark)), origin);
}
