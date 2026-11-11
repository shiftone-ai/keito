import type { Doc, Edge, Node, Port } from '../model/types';
import { ATTRIBUTES, LINE_ATTRIBUTES, LINE_TEXTS, PORT_ATTRIBUTES, WRITTEN_ONCE, isShared } from './scope';

/**
 * Edits of a shared board, read off the drawing the screen shows (within what scope.ts says a shared
 * board takes). Kept apart from Yjs (see nodes.ts and lines.ts for how they are written into the
 * project) so that the app's first load does not carry it.
 */

/** What an edit changes of one thing on the board (a node, a port, a line). An attribute set to undefined is taken off. */
export type Change = Record<string, unknown>;

/** What an edit does to things of one kind kept by id: puts some there (in that order, after the rest), changes some, takes some off. */
export interface Items<T> {
  add: T[];
  set: Map<string, Change>;
  remove: Set<string>;
}

/** A node an edit puts on the board. `back`: beneath every node already there (an area), else on top. */
export interface Placed {
  node: Node;
  back: boolean;
}

/**
 * One edit of a shared board: the nodes it puts there, the attributes it changes, the nodes it takes
 * off, and the same of each device's ports and of the lines. A place or a size is changed whole (x
 * with y, w with h), and a line's two ends together: two people moving a node at once end with the
 * place one of them gave it, never the x of one and the y of the other, and two pulling the ends of
 * one line, with the two ends one of them gave it.
 */
export interface BoardEdit {
  add: Placed[];
  set: Map<string, Change>;
  remove: Set<string>;
  /** Per device, by its id. */
  ports: Map<string, Items<Port>>;
  lines: Items<Edge>;
}

const noItems = <T>(): Items<T> => ({ add: [], set: new Map(), remove: new Set() });
const isNoItems = (e: Items<unknown>): boolean => !e.add.length && !e.set.size && !e.remove.size;

export const noEdit = (): BoardEdit => ({ ...noItems<Placed>(), ports: new Map(), lines: noItems() });

export const isNoEdit = (e: BoardEdit): boolean => isNoItems(e) && !e.ports.size && isNoItems(e.lines);

/** A device's ports are read apart (see portsBetween). */
const NODE_APART = new Set(['id', 'type', 'ports']);
// A legend is as tall as its rows: each screen works it out, and no one edits it.
const LEGEND_APART = new Set([...NODE_APART, 'h']);
const ID = new Set(['id']);
const PARTNER: Record<string, string> = { x: 'y', y: 'x', w: 'h', h: 'w', from: 'to', to: 'from' };
const PORT_EDITABLE = new Set<string>(PORT_ATTRIBUTES);
const LINE_EDITABLE = new Set<string>(LINE_ATTRIBUTES);
const LINE_KEPT = new Set<string>(['id', 'from', 'to', ...LINE_ATTRIBUTES, ...LINE_TEXTS]);

const keysOf = (a: object, b: object): Set<string> => new Set([...Object.keys(a), ...Object.keys(b)]);

/** Equal values, an unset one being the same as one set to undefined. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether every key `x` sets is one of `kept`. */
const holdsOnly = (x: object, kept: ReadonlySet<string>): boolean => Object.entries(x).every(([k, v]) => v === undefined || kept.has(k));

/** Whether a shared board keeps all that `node` holds. */
function addable(node: Node): boolean {
  if (!isShared(node.type)) return false;
  return holdsOnly(node, new Set<string>([...NODE_APART, 'x', 'y', 'w', 'h', 'text', ...ATTRIBUTES[node.type], ...(WRITTEN_ONCE[node.type] ?? [])]));
}

/** Whether a shared board keeps all that a line holds. */
const lineAddable = (line: Edge): boolean => holdsOnly(line, LINE_KEPT);

/**
 * The attributes `to` changes on `from` (the same thing), leaving out the keys `apart`; null when it
 * changes one not `editable`. One of a pair (see PARTNER) is changed with the other.
 */
function changeOf(from: object, to: object, editable: ReadonlySet<string>, apart: ReadonlySet<string>): Change | null {
  const was = from as Record<string, unknown>;
  const now = to as Record<string, unknown>;
  const change: Change = {};
  for (const key of keysOf(was, now)) {
    if (apart.has(key) || same(was[key], now[key])) continue;
    const partner = PARTNER[key];
    if (partner) change[partner] = now[partner];
    else if (!editable.has(key)) return null;
    change[key] = now[key];
  }
  return change;
}

function nodeChange(from: Node, to: Node): Change | null {
  if (from.type !== to.type || !isShared(to.type)) return null;
  return changeOf(from, to, new Set(ATTRIBUTES[to.type]), to.type === 'legend' ? LEGEND_APART : NODE_APART);
}
const portChange = (from: Port, to: Port): Change | null => changeOf(from, to, PORT_EDITABLE, ID);
const lineChange = (from: Edge, to: Edge): Change | null => changeOf(from, to, LINE_EDITABLE, ID);

/**
 * What turns the things `from` holds into those `to` holds, or null when `to` does what a shared
 * board does not take: puts there one it cannot keep (`addable`), changes one in a way it does not
 * take (`changed`), or puts the ones kept in another order.
 */
function itemsBetween<T extends { id: string }>(from: readonly T[], to: readonly T[], changed: (was: T, now: T) => Change | null, addable: (x: T) => boolean): Items<T> | null {
  const before = new Map(from.map((x) => [x.id, x]));
  const after = new Set(to.map((x) => x.id));
  const order = from.filter((x) => after.has(x.id));
  const edit = noItems<T>();
  let next = 0;
  for (const x of to) {
    const was = before.get(x.id);
    if (!was) {
      if (!addable(x)) return null;
      edit.add.push(x);
      continue;
    }
    if (order[next++] !== was) return null;
    if (was === x) continue;
    const change = changed(was, x);
    if (!change) return null;
    if (Object.keys(change).length) edit.set.set(x.id, change);
  }
  for (const x of from) if (!after.has(x.id)) edit.remove.add(x.id);
  return edit;
}

/**
 * The edit that turns `from` into `to`, two states of a shared board one after the other on screen;
 * null when `to` changes something a shared board does not take yet: anything but its nodes and
 * lines (its settings …), the order of its nodes, lines or a device's ports, a text typed by hand
 * (a node's, a port's name, a line's), or a node of a kind not shared.
 */
export function editBetween(from: Doc, to: Doc): BoardEdit | null {
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  for (const key of keysOf(a, b)) if (key !== 'nodes' && key !== 'edges' && !same(a[key], b[key])) return null;
  const nodes = itemsBetween(from.nodes, to.nodes, nodeChange, addable);
  const ports = nodes && portsBetween(from.nodes, to.nodes);
  const lines = ports && itemsBetween(from.edges, to.edges, lineChange, lineAddable);
  if (!nodes || !ports || !lines) return null;
  const firstKept = to.nodes.findIndex((n) => !nodes.add.includes(n));
  const underAll = new Set(to.nodes.slice(0, Math.max(0, firstKept)));
  return { add: nodes.add.map((node) => ({ node, back: underAll.has(node) })), set: nodes.set, remove: nodes.remove, ports, lines };
}

/** What changes the ports of each device kept, from `from` to `to` (see itemsBetween); null when one is changed in a way a shared board does not take. */
function portsBetween(from: readonly Node[], to: readonly Node[]): Map<string, Items<Port>> | null {
  const before = new Map(from.map((n) => [n.id, n]));
  const out = new Map<string, Items<Port>>();
  for (const now of to) {
    const was = before.get(now.id);
    if (was?.type !== 'device' || now.type !== 'device' || was.ports === now.ports) continue;
    const edit = itemsBetween(was.ports, now.ports, portChange, () => true);
    if (!edit) return null;
    if (!isNoItems(edit)) out.set(now.id, edit);
  }
  return out;
}

/** `first`, then `second`, as one edit of things of one kind (see BoardEdit for `T` of the nodes). */
function mergeItems<T>(first: Items<T>, second: Items<T>, idOf: (x: T) => string, changed: (x: T, change: Change) => T): Items<T> {
  const out: Items<T> = { add: [...first.add, ...second.add], set: new Map(first.set), remove: new Set(first.remove) };
  for (const [id, change] of second.set) {
    const i = out.add.findIndex((x) => idOf(x) === id);
    if (i >= 0) out.add[i] = changed(out.add[i], change);
    else out.set.set(id, { ...out.set.get(id), ...change });
  }
  for (const id of second.remove) {
    const i = out.add.findIndex((x) => idOf(x) === id);
    if (i >= 0) out.add.splice(i, 1);
    else {
      out.set.delete(id);
      out.remove.add(id);
    }
  }
  return out;
}

const changedPort = (p: Port, change: Change): Port => ({ ...p, ...change }) as Port;

/** `first`, then `second`, as one edit. */
export function mergeEdits(first: BoardEdit, second: BoardEdit): BoardEdit {
  const nodes = mergeItems(first, second, (x) => x.node.id, (x, change) => ({ ...x, node: { ...x.node, ...change } as Node }));
  const ports = new Map(first.ports);
  for (const [id, edit] of second.ports) {
    const i = nodes.add.findIndex((x) => x.node.id === id);
    const added = i >= 0 ? nodes.add[i].node : null;
    if (added?.type === 'device') nodes.add[i] = { ...nodes.add[i], node: { ...added, ports: withItems(added.ports, edit) } };
    else ports.set(id, mergeItems(ports.get(id) ?? noItems(), edit, (p) => p.id, changedPort));
  }
  for (const id of nodes.remove) ports.delete(id);
  return { ...nodes, ports, lines: mergeItems(first.lines, second.lines, (e) => e.id, (e, change) => ({ ...e, ...change }) as Edge) };
}

/** `list` with an edit of its things on top: a change to one no longer there is dropped, not bringing it back, and one put there under an id already there is not put again. */
function withItems<T extends { id: string }>(list: readonly T[], edit: Items<T>): T[] {
  const here = new Set(list.map((x) => x.id));
  const kept = list.filter((x) => !edit.remove.has(x.id)).map((x) => (edit.set.has(x.id) ? { ...x, ...edit.set.get(x.id) } : x));
  return [...kept, ...edit.add.filter((x) => !here.has(x.id))];
}

/**
 * The board with an edit not yet in the project on top. A change to a node, a port or a line no
 * longer there (taken off by someone else meanwhile) is dropped: it does not bring it back. Lines
 * whose ends went with it are left in (see validDrawing).
 */
export function withEdit(doc: Doc, edit: BoardEdit): Doc {
  if (isNoEdit(edit)) return doc;
  const here = new Set(doc.nodes.map((n) => n.id));
  const kept = doc.nodes
    .filter((n) => !edit.remove.has(n.id))
    .map((n) => {
      const changed = edit.set.has(n.id) ? ({ ...n, ...edit.set.get(n.id) } as Node) : n;
      const ports = edit.ports.get(n.id);
      return ports && changed.type === 'device' ? { ...changed, ports: withItems(changed.ports, ports) } : changed;
    });
  const added = (back: boolean): Node[] => edit.add.filter((x) => x.back === back && !here.has(x.node.id)).map((x) => x.node);
  return { ...doc, nodes: [...added(true), ...kept, ...added(false)], edges: withItems(doc.edges, edit.lines) };
}
