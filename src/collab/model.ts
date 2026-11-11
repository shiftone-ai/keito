import * as Y from 'yjs';
import { boardKind } from '../model/load';
import { COLOR_KEYS } from '../model/signals';
import type { Doc, Pt, ShapeKind, ShapeNode } from '../model/types';

/**
 * The form of a shared project's Y.Doc that this app reads and writes. A project of another form is
 * not opened (the server turns the connection away, see server/collab/server.ts).
 *
 * project: Y.Map { id, schema, title }
 * boards:  Y.Map<board id, Y.Map { id, title, kind, nodes: Y.Map<node id, Y.Map> }>
 * node:    Y.Map { id, type, shape, color, text: Y.Text, pos: {x, y}, size: {w, h}, order }
 *
 * A node's position and size are each one value: two editors moving it at once end with one of
 * their positions, never the x of one and the y of the other.
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

/** Write a new project into an empty Y.Doc: its id, schema and title, and one board holding one shape. */
export function seedProject(ydoc: Y.Doc, seed: ProjectSeed): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap<unknown>(META);
    meta.set('id', seed.id);
    meta.set('schema', SCHEMA);
    meta.set('title', seed.title);
    const nodes = new Y.Map<YNode>();
    const board = new Y.Map<unknown>();
    board.set('id', seed.board.id);
    board.set('title', seed.board.title);
    board.set('kind', 'free');
    board.set('nodes', nodes);
    ydoc.getMap<YBoard>(BOARDS).set(seed.board.id, board);
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

/** The project's boards, in a fixed order (by title, then id) so every client lists them alike. */
export function boardList(ydoc: Y.Doc): SharedBoardInfo[] {
  const out: SharedBoardInfo[] = [];
  ydoc.getMap<unknown>(BOARDS).forEach((board, id) => {
    if (board instanceof Y.Map) out.push({ id, title: str(board.get('title')), kind: boardKind(board.get('kind')) });
  });
  return out.sort((a, b) => a.title.localeCompare(b.title, 'ja') || byId(a.id, b.id));
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
 * A board as the drawing, the tables and the exports read it. Nodes come in their drawing order (by
 * `order`, then id); a node of a kind this version cannot show is left out rather than guessed at.
 */
export function boardDoc(ydoc: Y.Doc, boardId: string): Doc | null {
  const board = ydoc.getMap<unknown>(BOARDS).get(boardId);
  if (!(board instanceof Y.Map)) return null;
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
    meta: { title: str(board.get('title')), project: str(ydoc.getMap<unknown>(META).get('title')) },
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
