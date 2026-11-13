import type { Doc, Edge, Node, Port } from '../model/types';
import { type Run, runsBetween, withRuns } from './order';
import { ATTRIBUTES, LINE_ATTRIBUTES, LINE_TEXTS, PORT_ATTRIBUTES, WRITTEN_ONCE, isShared } from './scope';

/**
 * Edits of a shared board, read off the drawing the screen shows (within what scope.ts says a shared
 * board takes). Kept apart from Yjs (see nodes.ts and lines.ts for how they are written into the
 * project) so that the app's first load does not carry it.
 */

/** What an edit changes of one thing on the board (a node, a port, a line). An attribute set to undefined is taken off. */
export type Change = Record<string, unknown>;

/**
 * What an edit does to things of one kind kept by id: puts some there (in that order, after the
 * rest), changes some, takes some off, and puts some kept elsewhere in their order (see order.ts).
 */
export interface Items<T> {
  add: T[];
  set: Map<string, Change>;
  remove: Set<string>;
  moves: Run[];
}

/** What an edit does to the order of a list put by hand (see Doc.listOrder): drops it first when `reset`, then moves the runs, putting there the things not in it yet. */
export interface ListEdit {
  reset: boolean;
  moves: Run[];
}

/** A node an edit puts on the board. `back`: beneath every node already there (an area), else on top. */
export interface Placed {
  node: Node;
  back: boolean;
}

/**
 * One edit of a shared board: the nodes it puts there, the attributes it changes, the nodes it takes
 * off, the nodes it puts elsewhere in the order they are drawn in, the same of each device's ports
 * and of the lines, and the orders of the lists put by hand. A place or a size is changed whole (x
 * with y, w with h), and a line's two ends together: two people moving a node at once end with the
 * place one of them gave it, never the x of one and the y of the other, and two pulling the ends of
 * one line, with the two ends one of them gave it.
 */
export interface BoardEdit {
  add: Placed[];
  set: Map<string, Change>;
  remove: Set<string>;
  moves: Run[];
  /** Per device, by its id. */
  ports: Map<string, Items<Port>>;
  lines: Items<Edge>;
  /** Per list, by its name in Doc.listOrder. */
  lists: Map<string, ListEdit>;
}

const noItems = <T>(): Items<T> => ({ add: [], set: new Map(), remove: new Set(), moves: [] });
const isNoItems = (e: Items<unknown>): boolean => !e.add.length && !e.set.size && !e.remove.size && !e.moves.length;

export const noEdit = (): BoardEdit => ({ ...noItems<Placed>(), ports: new Map(), lines: noItems(), lists: new Map() });

export const isNoEdit = (e: BoardEdit): boolean => isNoItems(e) && !e.ports.size && isNoItems(e.lines) && !e.lists.size;

/** A device's ports are read apart (see portsBetween). */
const NODE_APART = new Set(['id', 'type', 'ports']);
// A legend is as tall as its rows: each screen works it out, and no one edits it.
const LEGEND_APART = new Set([...NODE_APART, 'h']);
const ID = new Set(['id']);
/** What of a board an edit of a shared board changes: anything else is a setting of the board. */
const EDITED = new Set(['nodes', 'edges', 'listOrder']);
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
 * board does not take: puts there one it cannot keep (`addable`), or changes one in a way it does
 * not take (`changed`).
 */
function itemsBetween<T extends { id: string }>(from: readonly T[], to: readonly T[], changed: (was: T, now: T) => Change | null, addable: (x: T) => boolean): Items<T> | null {
  const before = new Map(from.map((x) => [x.id, x]));
  const after = new Set(to.map((x) => x.id));
  const edit = noItems<T>();
  for (const x of to) {
    const was = before.get(x.id);
    if (!was) {
      if (!addable(x)) return null;
      edit.add.push(x);
      continue;
    }
    if (was === x) continue;
    const change = changed(was, x);
    if (!change) return null;
    if (Object.keys(change).length) edit.set.set(x.id, change);
  }
  for (const x of from) if (!after.has(x.id)) edit.remove.add(x.id);
  const ids = (list: readonly T[], kept: { has(id: string): boolean }): string[] => list.filter((x) => kept.has(x.id)).map((x) => x.id);
  edit.moves = runsBetween(ids(from, after), ids(to, before));
  return edit;
}

/** What changes the orders of the lists put by hand, from `from` to `to` (see Doc.listOrder). */
function listsBetween(from: Doc['listOrder'] = {}, to: Doc['listOrder'] = {}): Map<string, ListEdit> {
  const out = new Map<string, ListEdit>();
  for (const list of keysOf(from, to)) {
    const was = from[list] ?? [];
    const now = to[list] ?? [];
    if (!same(was, now)) out.set(list, now.length ? { reset: false, moves: runsBetween(was, now) } : { reset: true, moves: [] });
  }
  return out;
}

/**
 * The edit that turns `from` into `to`, two states of a shared board one after the other on screen;
 * null when `to` changes something a shared board does not take yet: anything but its nodes, its
 * lines and the orders of its lists (its settings …), a text typed by hand (a node's, a port's
 * name, a line's), or a node of a kind not shared.
 */
export function editBetween(from: Doc, to: Doc): BoardEdit | null {
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  for (const key of keysOf(a, b)) if (!EDITED.has(key) && !same(a[key], b[key])) return null;
  const nodes = itemsBetween(from.nodes, to.nodes, nodeChange, addable);
  const ports = nodes && portsBetween(from.nodes, to.nodes);
  const lines = ports && itemsBetween(from.edges, to.edges, lineChange, lineAddable);
  if (!nodes || !ports || !lines) return null;
  const firstKept = to.nodes.findIndex((n) => !nodes.add.includes(n));
  const underAll = new Set(to.nodes.slice(0, Math.max(0, firstKept)));
  return { add: nodes.add.map((node) => ({ node, back: underAll.has(node) })), set: nodes.set, remove: nodes.remove, moves: nodes.moves, ports, lines, lists: listsBetween(from.listOrder, to.listOrder) };
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

/** `first`, then `second`, as one edit of things of one kind (see BoardEdit for `T` of the nodes). A thing put there and moved goes where it is put. */
function mergeItems<T>(first: Items<T>, second: Items<T>, idOf: (x: T) => string, changed: (x: T, change: Change) => T): Items<T> {
  const out: Items<T> = { add: [...first.add, ...second.add], set: new Map(first.set), remove: new Set(first.remove), moves: [...first.moves] };
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
  const added = new Set(out.add.map(idOf));
  for (const run of second.moves) {
    const ids = run.ids.filter((id) => !added.has(id));
    if (ids.length) out.moves.push({ ...run, ids });
  }
  return out;
}

/** `first`, then `second`, as one edit of the lists' orders. */
function mergeLists(first: Map<string, ListEdit>, second: Map<string, ListEdit>): Map<string, ListEdit> {
  const out = new Map(first);
  for (const [list, edit] of second) {
    const was = out.get(list);
    out.set(list, !was || edit.reset ? edit : { reset: was.reset, moves: [...was.moves, ...edit.moves] });
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
  return { ...nodes, ports, lines: mergeItems(first.lines, second.lines, (e) => e.id, (e, change) => ({ ...e, ...change }) as Edge), lists: mergeLists(first.lists, second.lists) };
}

/** Things in the order their ids take with the runs moved (see withRuns). */
function inRuns<T extends { id: string }>(list: T[], runs: readonly Run[]): T[] {
  if (!runs.length) return list;
  const byId = new Map(list.map((x) => [x.id, x]));
  return withRuns(list.map((x) => x.id), runs).map((id) => byId.get(id)!);
}

/** `list` with an edit of its things on top: a change to one no longer there is dropped, not bringing it back, and one put there under an id already there is not put again. */
function withItems<T extends { id: string }>(list: readonly T[], edit: Items<T>): T[] {
  const here = new Set(list.map((x) => x.id));
  const kept = list.filter((x) => !edit.remove.has(x.id)).map((x) => (edit.set.has(x.id) ? { ...x, ...edit.set.get(x.id) } : x));
  return [...inRuns(kept, edit.moves), ...edit.add.filter((x) => !here.has(x.id))];
}

/** The lists' orders with an edit of them on top. */
function withLists(order: Doc['listOrder'], lists: Map<string, ListEdit>): Doc['listOrder'] {
  const out = { ...order };
  for (const [list, { reset, moves }] of lists) {
    const ids = withRuns(reset ? [] : (out[list] ?? []), moves, true);
    if (ids.length) out[list] = ids;
    else delete out[list];
  }
  return Object.keys(out).length ? out : undefined;
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
  const nodes = [...added(true), ...inRuns(kept, edit.moves), ...added(false)];
  return { ...doc, nodes, edges: withItems(doc.edges, edit.lines), ...(edit.lists.size ? { listOrder: withLists(doc.listOrder, edit.lists) } : {}) };
}
