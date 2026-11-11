import * as Y from 'yjs';
import { COLOR_KEYS } from '../model/signals';
import type { Doc, Pt, ShapeKind, ShapeNode } from '../model/types';
import { boardNodes, liveBoard, putBoard } from './boards';

/**
 * The form of a shared project's Y.Doc that this app reads and writes. A project of another form is
 * not opened (the server turns the connection away, see server/collab/server.ts).
 *
 * project:   Y.Map { id, schema, title }
 * boards:    Y.Map<board id, Y.Map { id, title, kind, nodes: Y.Map<node id, Y.Map> }>
 * node:      Y.Map { id, type, shape, color, text: Y.Text, pos: {x, y}, size: {w, h}, order }
 * deletions: Y.Map<mark, board id>
 *
 * A node's position and size are each one value: two editors moving it at once end with one of
 * their positions, never the x of one and the y of the other. Which boards there are, and how one
 * stays deleted, is boards.ts's.
 */
export const SCHEMA = 1;

export interface ProjectSeed {
  id: string;
  title: string;
  board: { id: string; title: string };
  shape: { id: string; text: string; x: number; y: number; w: number; h: number };
}

const META = 'project';
const SHAPES: ShapeKind[] = ['rect', 'round', 'diamond', 'ellipse', 'cloud'];

type YNode = Y.Map<unknown>;

/** Write a new project into an empty Y.Doc: its id, schema and title, and one board holding one shape. */
export function seedProject(ydoc: Y.Doc, seed: ProjectSeed): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap<unknown>(META);
    meta.set('id', seed.id);
    meta.set('schema', SCHEMA);
    meta.set('title', seed.title);
    const nodes = putBoard(ydoc, { ...seed.board, kind: 'free' });
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

/** The project's name. */
export const projectTitle = (ydoc: Y.Doc): string => str(ydoc.getMap<unknown>(META).get('title'));

/** Rename the project. Its id, and so where it is shared, stays the same. */
export function renameProject(ydoc: Y.Doc, title: string, origin: unknown): void {
  if (projectTitle(ydoc) !== title) ydoc.transact(() => ydoc.getMap<unknown>(META).set('title', title), origin);
}

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
 * A board as the drawing, the tables and the exports read it; null for one deleted, or not in the
 * project. Nodes come in their drawing order (by `order`, then id); a node of a kind this version
 * cannot show is left out rather than guessed at.
 */
export function boardDoc(ydoc: Y.Doc, boardId: string): Doc | null {
  const board = liveBoard(ydoc, boardId);
  if (!board) return null;
  const listed: { order: number; node: ShapeNode }[] = [];
  boardNodes(ydoc, boardId)?.forEach((value, id) => {
    const node = value instanceof Y.Map ? shapeOf(id, value as YNode) : null;
    if (node) listed.push({ order: num((value as YNode).get('order')), node });
  });
  listed.sort((a, b) => a.order - b.order || byId(a.node.id, b.node.id));
  return {
    version: 1,
    id: boardId,
    kind: board.kind,
    meta: { title: board.title, project: projectTitle(ydoc) },
    nodes: listed.map((x) => x.node),
    edges: [],
  };
}

/**
 * Put nodes of a board where they were let go, as one transaction under `origin`. A node no longer
 * on the board is not brought back by being moved.
 */
export function placeNodes(ydoc: Y.Doc, boardId: string, moves: ReadonlyMap<string, Pt>, origin: unknown): void {
  const nodes = boardNodes(ydoc, boardId);
  if (!nodes) return;
  ydoc.transact(() => {
    for (const [id, { x, y }] of moves) {
      const node = nodes.get(id);
      if (node instanceof Y.Map) node.set('pos', { x, y });
    }
  }, origin);
}
