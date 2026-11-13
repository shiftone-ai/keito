import * as Y from 'yjs';
import type { Doc } from '../model/types';
import { boardLines, boardNodes, liveBoard, putBoard } from './boards';
import type { BoardEdit } from './edits';
import { type YMap, readInOrder, textOf } from './entries';
import { readLines, writeLines } from './lines';
import { readListOrder, writeListOrder } from './listOrder';
import { nodeOf, writeNodes } from './nodes';
import { validDrawing } from './valid';

/**
 * The form of a shared project's Y.Doc that this app reads and writes. A project of another form is
 * not opened (the server turns the connection away, see server/collab/server.ts).
 *
 * project:   Y.Map { id, schema, title }
 * boards:    Y.Map<board id, Y.Map { id, title, kind, nodes: Y.Map<node id, Y.Map>, lines: Y.Map<line id, Y.Map> }>
 * deletions: Y.Map<mark, board id>
 *
 * See nodes.ts for a node, lines.ts for a line, order.ts for the order they are drawn and listed in,
 * listOrder.ts for the orders of the lists put by hand. Which boards there are, and how one stays
 * deleted, is boards.ts's.
 */
export const SCHEMA = 2;

export interface ProjectSeed {
  id: string;
  title: string;
  board: { id: string; title: string; kind?: Doc['kind'] };
  shape: { id: string; text: string; x: number; y: number; w: number; h: number };
}

const META = 'project';

/** Write a new project into an empty Y.Doc: its id, schema and title, and one board holding one shape. */
export function seedProject(ydoc: Y.Doc, seed: ProjectSeed): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap<unknown>(META);
    meta.set('id', seed.id);
    meta.set('schema', SCHEMA);
    meta.set('title', seed.title);
    const nodes = putBoard(ydoc, { ...seed.board, kind: seed.board.kind ?? 'free' });
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

/** The project's name. */
export const projectTitle = (ydoc: Y.Doc): string => textOf(ydoc.getMap<unknown>(META).get('title'));

/** Rename the project. Its id, and so where it is shared, stays the same. */
export function renameProject(ydoc: Y.Doc, title: string, origin: unknown): void {
  if (projectTitle(ydoc) !== title) ydoc.transact(() => ydoc.getMap<unknown>(META).set('title', title), origin);
}

/**
 * A board as the drawing, the tables and the exports read it; null for one deleted, or not in the
 * project. Nodes come in their drawing order, lines in the order they were put there (each by
 * `order`, then id), and the lists in the orders put by hand; a node of a kind this version cannot
 * show is left out rather than guessed at, and so is a line it cannot draw (see validDrawing).
 */
export function boardDoc(ydoc: Y.Doc, boardId: string): Doc | null {
  const board = liveBoard(ydoc, boardId);
  if (!board) return null;
  const nodes = boardNodes(ydoc, boardId);
  const lines = boardLines(ydoc, boardId);
  const doc: Doc = {
    version: 1,
    id: boardId,
    kind: board.kind,
    meta: { title: board.title, project: projectTitle(ydoc) },
    nodes: nodes ? readInOrder(nodes, nodeOf) : [],
    edges: lines ? readLines(lines) : [],
  };
  const listOrder = readListOrder([nodes, lines].filter((map): map is YMap => !!map), new Set([...doc.nodes, ...doc.edges].map((x) => x.id)));
  return validDrawing(listOrder ? { ...doc, listOrder } : doc);
}

/** What a board holds that its edits change. */
export interface BoardParts {
  nodes: YMap;
  lines: YMap;
}

/** Write an edit of a board into what it holds (within the caller's transaction): see writeNodes, writeLines and writeListOrder. */
export function writeEdit(board: BoardParts, edit: BoardEdit): void {
  writeNodes(board.nodes, edit);
  writeLines(board.lines, edit.lines);
  writeListOrder([board.nodes, board.lines], edit.lists);
}
