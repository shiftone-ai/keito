import type { Doc, Node } from '../model/types';
import { ATTRIBUTES, WRITTEN_ONCE, isShared } from './scope';

/**
 * Edits of a shared board, read off the drawing the screen shows (within what scope.ts says a shared
 * board takes). Kept apart from Yjs (see nodes.ts for how they are written into the project) so that
 * the app's first load does not carry it.
 */

/** An attribute set to undefined is taken off the node. */
export type NodeChange = Record<string, unknown>;

/**
 * One edit of a shared board: the nodes it puts there, the attributes it changes, the nodes it takes
 * off. A place or a size is changed whole (x with y, w with h): two people moving a node at once end
 * with the place one of them gave it, never the x of one and the y of the other.
 */
export interface NodeEdit {
  /** In the order put there. `back`: beneath every node already there (an area), else on top. */
  add: { node: Node; back: boolean }[];
  set: Map<string, NodeChange>;
  remove: Set<string>;
}

export const noEdit = (): NodeEdit => ({ add: [], set: new Map(), remove: new Set() });

export const isNoEdit = (e: NodeEdit): boolean => !e.add.length && !e.set.size && !e.remove.size;

const IDENTITY = new Set(['id', 'type']);
const PARTNER: Record<string, string> = { x: 'y', y: 'x', w: 'h', h: 'w' };

const keysOf = (a: object, b: object): Set<string> => new Set([...Object.keys(a), ...Object.keys(b)]);

/** Equal values, an unset one being the same as one set to undefined. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a shared board keeps all that `node` holds. */
function addable(node: Node): boolean {
  if (!isShared(node.type)) return false;
  const known = new Set<string>([...IDENTITY, 'x', 'y', 'w', 'h', 'text', ...ATTRIBUTES[node.type], ...(WRITTEN_ONCE[node.type] ?? [])]);
  return Object.entries(node).every(([k, v]) => v === undefined || known.has(k));
}

/** The attributes `to` changes on `from` (the same node), or null when it changes one a shared board does not take. */
function changeOf(from: Node, to: Node): NodeChange | null {
  if (from.type !== to.type || !isShared(to.type)) return null;
  const editable = new Set<string>(ATTRIBUTES[to.type]);
  const was = from as unknown as Record<string, unknown>;
  const now = to as unknown as Record<string, unknown>;
  const change: NodeChange = {};
  for (const key of keysOf(was, now)) {
    if (IDENTITY.has(key) || same(was[key], now[key])) continue;
    // A legend is as tall as its rows: each screen works it out, and no one edits it.
    if (to.type === 'legend' && key === 'h') continue;
    const partner = PARTNER[key];
    if (partner) change[partner] = now[partner];
    else if (!editable.has(key)) return null;
    change[key] = now[key];
  }
  return change;
}

/**
 * The edit that turns `from` into `to`, two states of a shared board one after the other on screen;
 * null when `to` changes something a shared board does not take yet: anything but its nodes (its
 * lines, its settings …), the drawing order, a node's text or ports, or a node of a kind not shared.
 */
export function editBetween(from: Doc, to: Doc): NodeEdit | null {
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  for (const key of keysOf(a, b)) if (key !== 'nodes' && !same(a[key], b[key])) return null;
  const before = new Map(from.nodes.map((n) => [n.id, n]));
  const after = new Set(to.nodes.map((n) => n.id));
  const order = from.nodes.filter((n) => after.has(n.id));
  const edit = noEdit();
  let next = 0;
  for (const n of to.nodes) {
    const was = before.get(n.id);
    if (!was) {
      if (!addable(n)) return null;
      edit.add.push({ node: n, back: next === 0 && order.length > 0 });
      continue;
    }
    if (order[next++] !== was) return null;
    if (was === n) continue;
    const change = changeOf(was, n);
    if (!change) return null;
    if (Object.keys(change).length) edit.set.set(n.id, change);
  }
  for (const n of from.nodes) if (!after.has(n.id)) edit.remove.add(n.id);
  return edit;
}

/** `first`, then `second`, as one edit. */
export function mergeEdits(first: NodeEdit, second: NodeEdit): NodeEdit {
  const out: NodeEdit = { add: [...first.add, ...second.add], set: new Map(first.set), remove: new Set(first.remove) };
  for (const [id, change] of second.set) {
    const i = out.add.findIndex((x) => x.node.id === id);
    if (i >= 0) out.add[i] = { ...out.add[i], node: { ...out.add[i].node, ...change } as Node };
    else out.set.set(id, { ...out.set.get(id), ...change });
  }
  for (const id of second.remove) {
    const i = out.add.findIndex((x) => x.node.id === id);
    if (i >= 0) out.add.splice(i, 1);
    else {
      out.set.delete(id);
      out.remove.add(id);
    }
  }
  return out;
}

/**
 * The board with an edit not yet in the project on top. A change to a node no longer there (taken
 * off by someone else meanwhile) is dropped: it does not bring the node back.
 */
export function withEdit(doc: Doc, edit: NodeEdit): Doc {
  if (isNoEdit(edit)) return doc;
  const here = new Set(doc.nodes.map((n) => n.id));
  const kept = doc.nodes.filter((n) => !edit.remove.has(n.id)).map((n) => (edit.set.has(n.id) ? ({ ...n, ...edit.set.get(n.id) } as Node) : n));
  const added = (back: boolean): Node[] => edit.add.filter((x) => x.back === back && !here.has(x.node.id)).map((x) => x.node);
  return { ...doc, nodes: [...added(true), ...kept, ...added(false)] };
}

