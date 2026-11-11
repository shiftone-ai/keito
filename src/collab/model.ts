import * as Y from 'yjs';
import type { BoardKind } from '../model/kinds';
import { boardKind } from '../model/load';
import { COLOR_KEYS } from '../model/signals';
import type { Doc, Pt, ShapeKind, ShapeNode } from '../model/types';

/**
 * The form of a shared project's Y.Doc that this app reads and writes. A project of another form is
 * not opened (the server turns the connection away, see server/collab/server.ts).
 *
 * project: Y.Map { id, schema, title }
 * boards:  Y.Map<board id, Y.Map { id, title, kind, deleted?: true, nodes: Y.Map<node id, Y.Map> }>
 * node:    Y.Map { id, type, shape, color, text: Y.Text, pos: {x, y}, size: {w, h}, order }
 *
 * A node's position and size are each one value: two editors moving it at once end with one of
 * their positions, never the x of one and the y of the other.
 *
 * A board is never taken out of `boards`: deleting one marks it `deleted`, and only restoring it
 * takes the mark off. An edit made on the board by someone who had not yet heard of the delete
 * changes what the board holds, not the mark, so it does not bring the board back.
 */
export const SCHEMA = 1;

export interface SharedBoardInfo {
  id: string;
  title: string;
  kind: Doc['kind'];
}

export interface ProjectSeed {
  id: string;
  title: string;
  board: { id: string; title: string };
  shape: { id: string; text: string; x: number; y: number; w: number; h: number };
}

const META = 'project';
const BOARDS = 'boards';
const SHAPES: ShapeKind[] = ['rect', 'round', 'diamond', 'ellipse', 'cloud'];

type YNode = Y.Map<unknown>;
type YBoard = Y.Map<unknown>;

/** A board of the project, deleted or not; null for an id the project never had. */
function yBoard(ydoc: Y.Doc, id: string): YBoard | null {
  const board = ydoc.getMap<unknown>(BOARDS).get(id);
  return board instanceof Y.Map ? board : null;
}
const isDeleted = (board: YBoard): boolean => board.get('deleted') === true;

/** A new board, holding no nodes yet, to be put in `boards`. */
function newBoard(board: { id: string; title: string; kind: BoardKind }): YBoard {
  const y = new Y.Map<unknown>();
  y.set('id', board.id);
  y.set('title', board.title);
  y.set('kind', board.kind);
  y.set('nodes', new Y.Map<YNode>());
  return y;
}

/** Write a new project into an empty Y.Doc: its id, schema and title, and one board holding one shape. */
export function seedProject(ydoc: Y.Doc, seed: ProjectSeed): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap<unknown>(META);
    meta.set('id', seed.id);
    meta.set('schema', SCHEMA);
    meta.set('title', seed.title);
    const board = newBoard({ ...seed.board, kind: 'free' });
    ydoc.getMap<YBoard>(BOARDS).set(seed.board.id, board);
    const nodes = board.get('nodes') as Y.Map<YNode>;
    const { id, text, x, y, w, h } = seed.shape;
    const node = new Y.Map<unknown>();
    nodes.set(id, node);
    node.set('id', id);
    node.set('type', 'shape');
    node.set('shape', 'rect');
    node.set('color', 'white');
    node.set('text', new Y.Text(text));
    node.set('pos', { x, y });
    node.set('size', { w, h });
    node.set('order', 0);
  });
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v instanceof Y.Text ? v.toString() : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const pair = (v: unknown, a: 'x' | 'w', b: 'y' | 'h'): [number, number] | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o[a] === 'number' && typeof o[b] === 'number' ? [o[a] as number, o[b] as number] : null;
};
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The project's boards that `which` takes, in a fixed order (by title, then id) so every client lists them alike. */
function listBoards(ydoc: Y.Doc, which: (board: YBoard) => boolean): SharedBoardInfo[] {
  const out: SharedBoardInfo[] = [];
  ydoc.getMap<unknown>(BOARDS).forEach((board, id) => {
    if (board instanceof Y.Map && which(board)) out.push({ id, title: str(board.get('title')), kind: boardKind(board.get('kind')) });
  });
  return out.sort((a, b) => a.title.localeCompare(b.title, 'ja') || byId(a.id, b.id));
}

/** The project's boards, the deleted ones left out. */
export const boardList = (ydoc: Y.Doc): SharedBoardInfo[] => listBoards(ydoc, (board) => !isDeleted(board));

/** The project's deleted boards, which can be restored. */
export const deletedBoardList = (ydoc: Y.Doc): SharedBoardInfo[] => listBoards(ydoc, isDeleted);

/** The project's name. */
export const projectTitle = (ydoc: Y.Doc): string => str(ydoc.getMap<unknown>(META).get('title'));

function shapeOf(id: string, node: YNode): ShapeNode | null {
  if (node.get('type') !== 'shape') return null;
  const pos = pair(node.get('pos'), 'x', 'y');
  const size = pair(node.get('size'), 'w', 'h');
  if (!pos || !size) return null;
  const shape = node.get('shape') as ShapeKind;
  const color = node.get('color') as ShapeNode['color'];
  return {
    id,
    type: 'shape',
    shape: SHAPES.includes(shape) ? shape : 'rect',
    color: COLOR_KEYS.includes(color) ? color : 'white',
    text: str(node.get('text')),
    x: pos[0],
    y: pos[1],
    w: size[0],
    h: size[1],
  };
}

/**
 * A board as the drawing, the tables and the exports read it. Nodes come in their drawing order (by
 * `order`, then id); a node of a kind this version cannot show is left out rather than guessed at.
 */
export function boardDoc(ydoc: Y.Doc, boardId: string): Doc | null {
  const board = yBoard(ydoc, boardId);
  if (!board || isDeleted(board)) return null;
  const nodes = board.get('nodes');
  const listed: { order: number; node: ShapeNode }[] = [];
  if (nodes instanceof Y.Map)
    nodes.forEach((value, id) => {
      const node = value instanceof Y.Map ? shapeOf(id, value as YNode) : null;
      if (node) listed.push({ order: num((value as YNode).get('order')), node });
    });
  listed.sort((a, b) => a.order - b.order || byId(a.node.id, b.node.id));
  return {
    version: 1,
    id: boardId,
    kind: boardKind(board.get('kind')),
    meta: { title: str(board.get('title')), project: projectTitle(ydoc) },
    nodes: listed.map((x) => x.node),
    edges: [],
  };
}

/**
 * Put nodes of a board where they were let go, as one transaction under `origin`. A node no longer
 * on the board is not brought back by being moved.
 */
export function placeNodes(ydoc: Y.Doc, boardId: string, moves: ReadonlyMap<string, Pt>, origin: unknown): void {
  const board = ydoc.getMap<unknown>(BOARDS).get(boardId);
  const nodes = board instanceof Y.Map ? board.get('nodes') : null;
  if (!(nodes instanceof Y.Map)) return;
  ydoc.transact(() => {
    for (const [id, { x, y }] of moves) {
      const node = nodes.get(id);
      if (node instanceof Y.Map) node.set('pos', { x, y });
    }
  }, origin);
}

/** Add an empty board to the project, under an id of its own, as one transaction under `origin`. */
export function addBoard(ydoc: Y.Doc, board: { id: string; title: string; kind: BoardKind }, origin: unknown): void {
  ydoc.transact(() => ydoc.getMap<YBoard>(BOARDS).set(board.id, newBoard(board)), origin);
}

/** Rename a board of the project; a deleted board is left as it is. */
export function renameBoard(ydoc: Y.Doc, id: string, title: string, origin: unknown): void {
  const board = yBoard(ydoc, id);
  if (board && !isDeleted(board) && str(board.get('title')) !== title) ydoc.transact(() => board.set('title', title), origin);
}

/** Mark a board deleted. What it holds is kept, for `restoreBoard`. */
export function deleteBoard(ydoc: Y.Doc, id: string, origin: unknown): void {
  const board = yBoard(ydoc, id);
  if (board && !isDeleted(board)) ydoc.transact(() => board.set('deleted', true), origin);
}

/**
 * Take the delete mark off a board. A delete made at the same time, by someone who had not seen this,
 * is not undone: the board stays deleted.
 */
export function restoreBoard(ydoc: Y.Doc, id: string, origin: unknown): void {
  const board = yBoard(ydoc, id);
  if (board && isDeleted(board)) ydoc.transact(() => board.delete('deleted'), origin);
}

/** Rename the project. Its id, and so where it is shared, stays the same. */
export function renameProject(ydoc: Y.Doc, title: string, origin: unknown): void {
  if (projectTitle(ydoc) !== title) ydoc.transact(() => ydoc.getMap<unknown>(META).set('title', title), origin);
}
