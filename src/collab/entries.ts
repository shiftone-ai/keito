import * as Y from 'yjs';
import type { Change, Items } from './edits';
import { type Run, inOrder, placeRuns } from './order';

/**
 * Reading and writing the project's Y.Maps that hold things by id (a board's nodes and lines, a
 * device's ports): what a value read from one must be, its texts, the order every client lists them
 * in, and an edit of them.
 */

export type YMap = Y.Map<unknown>;
/** What a value read from the project must be to be taken: anything else is left unread. */
export type Check = (v: unknown) => boolean;

export const oneOf = (values: readonly unknown[]): Check => (v) => values.includes(v);
export const isNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v);
export const isString: Check = (v) => typeof v === 'string';
export const isBoolean: Check = (v) => typeof v === 'boolean';

/** A text the project holds, as typed (a plain string from an older writer is read as it is). */
export const textOf = (v: unknown, fallback = ''): string => (v instanceof Y.Text ? v.toString() : typeof v === 'string' ? v : fallback);

/** The place of an entry in the order of its map (see order.ts): lower comes first (further back, for nodes). */
const orderOf = (entry: unknown): number => {
  const order = entry instanceof Y.Map ? entry.get('order') : undefined;
  return isNumber(order) ? (order as number) : 0;
};

/** The entries of a map as `read` reads them (those it cannot, left out), in their order (see inOrder). */
export function readInOrder<T extends { id: string }>(map: YMap, read: (id: string, entry: YMap) => T | null): T[] {
  const items = new Map<string, T>();
  const places = new Map<string, number>();
  map.forEach((entry, id) => {
    const item = entry instanceof Y.Map ? read(id, entry as YMap) : null;
    if (!item) return;
    items.set(item.id, item);
    places.set(item.id, orderOf(entry));
  });
  return inOrder(places).map((id) => items.get(id)!);
}

/** The first and the last place in the order of a map's entries (both 0 for none). */
export function orderRange(map: YMap): { back: number; front: number } {
  if (!map.size) return { back: 0, front: 0 };
  let back = Infinity;
  let front = -Infinity;
  map.forEach((entry) => {
    back = Math.min(back, orderOf(entry));
    front = Math.max(front, orderOf(entry));
  });
  return { back, front };
}

/** Put entries of a map elsewhere in its order (see placeRuns), within the caller's transaction. */
export function moveEntries(map: YMap, runs: readonly Run[]): void {
  if (!runs.length) return;
  const places = new Map<string, number>();
  map.forEach((entry, id) => entry instanceof Y.Map && places.set(id, orderOf(entry)));
  placeRuns(places, runs, (id) => places.has(id), (id, place) => (map.get(id) as YMap).set('order', place));
}

/** Set each value of a change under its key (but those `apart`), taking off the keys set to undefined. */
export function setEach(entry: YMap, change: Change, apart: ReadonlySet<string> = new Set()): void {
  for (const [key, v] of Object.entries(change)) {
    if (apart.has(key)) continue;
    if (v === undefined) entry.delete(key);
    else entry.set(key, v);
  }
}

/**
 * Write an edit of what a map holds by id (within the caller's transaction): what it takes off, what
 * it changes (each entry by `change`), what it moves in the order, then what it puts there, after
 * the rest (by `put`). A change to an entry no longer there is dropped, never bringing it back; one
 * put there under an id already taken is not written over what holds it.
 */
export function writeItems<T extends { id: string }>(map: YMap, edit: Items<T>, change: (entry: YMap, c: Change) => void, put: (map: YMap, item: T, order: number) => void): void {
  for (const id of edit.remove) map.delete(id);
  for (const [id, c] of edit.set) {
    const entry = map.get(id);
    if (entry instanceof Y.Map) change(entry as YMap, c);
  }
  moveEntries(map, edit.moves);
  let front = orderRange(map).front;
  for (const item of edit.add) if (!map.has(item.id)) put(map, item, ++front);
}
