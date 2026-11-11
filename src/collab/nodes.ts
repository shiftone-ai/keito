import * as Y from 'yjs';
import { wholeDevice } from '../model/load';
import { COLOR_KEYS } from '../model/signals';
import { FILL_STYLES, type Node, type Port, SHAPE_KINDS } from '../model/types';
import type { BoardEdit, Change, Items } from './edits';
import { ATTRIBUTES, type Attribute, type SharedType, isShared } from './scope';

/**
 * A node of a shared board as the project holds it (see model.ts for the rest of the project):
 *
 * node:   Y.Map { id, type, order, pos: {x, y}, size: {w, h}, text: Y.Text, …its attributes }
 * device: … note: Y.Text, ports: Y.Map<port id, Y.Map { id, name: Y.Text, side, signal, order }>
 * legend: … names: Y.Map<row, Y.Text>, hidden: Y.Map<row, true>
 *
 * Each attribute is a key of its own (see ATTRIBUTES in scope.ts), so people changing different
 * attributes of one node keep all their changes; so is a port's, and each port is an entry of its
 * own, so ports two people add to one device at once are both kept. What is typed by hand is a Y.Text.
 */

export type YMap = Y.Map<unknown>;
export type Check = (v: unknown) => boolean;

export const oneOf = (values: readonly unknown[]): Check => (v) => values.includes(v);
export const isNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v);
export const isString: Check = (v) => typeof v === 'string';
export const isBoolean: Check = (v) => typeof v === 'boolean';

/** What a value written under each attribute must be to be read back: anything else is left unread. */
const CHECKS = {
  shape: oneOf(SHAPE_KINDS),
  color: oneOf(COLOR_KEYS),
  fill: oneOf(FILL_STYLES),
  fontSize: isNumber,
  at: isNumber,
  watts: isNumber,
  capacity: isNumber,
  qty: isNumber,
  price: isNumber,
  bold: isBoolean,
  dash: isBoolean,
  done: isBoolean,
  venue: isBoolean,
  devices: isBoolean,
  maker: isString,
  model: isString,
  category: isString,
  url: isString,
  vendor: isString,
  ip: isString,
  host: isString,
} satisfies Record<Exclude<Attribute, 'hidden'>, Check>;

/** What a node of each kind holds when the project says nothing of it. */
const DEFAULTS: Partial<Record<SharedType, Record<string, unknown>>> = {
  shape: { shape: 'rect', color: 'white' },
  sticky: { color: 'yellow' },
};

/** A text the project holds, as typed (a plain string from an older writer is read as it is). */
export const textOf = (v: unknown, fallback = ''): string => (v instanceof Y.Text ? v.toString() : typeof v === 'string' ? v : fallback);
export const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (v: unknown): number => (isNumber(v) ? (v as number) : 0);

/** The place in the order of the entries of a map (the nodes of a board, its lines, a device's ports): lower comes first. */
export const orderOf = (entry: unknown): number => (entry instanceof Y.Map ? num(entry.get('order')) : 0);

/** The entries of a map read (those not read left out), in their order, then by id, so that every client lists them alike. */
export function inOrder<T extends { id: string }>(map: YMap, read: (id: string, entry: YMap) => T | null): T[] {
  const listed: { order: number; item: T }[] = [];
  map.forEach((entry, id) => {
    const item = entry instanceof Y.Map ? read(id, entry as YMap) : null;
    if (item) listed.push({ order: orderOf(entry), item });
  });
  return listed.sort((a, b) => a.order - b.order || byId(a.item.id, b.item.id)).map((x) => x.item);
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

function pair(v: unknown, a: 'x' | 'w', b: 'y' | 'h'): [number, number] | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return isNumber(o[a]) && isNumber(o[b]) ? [o[a] as number, o[b] as number] : null;
}

/** An attribute as the drawing reads it; undefined when unset or not what it must be. A set of rows is the keys of a Y.Map. */
function readAttribute(node: YMap, key: Attribute): unknown {
  const v = node.get(key);
  if (key === 'hidden') return v instanceof Y.Map && v.size ? [...(v as YMap).keys()].sort() : undefined;
  return CHECKS[key](v) ? v : undefined;
}

/** Set an attribute of a node on its own (undefined takes it off). A set of rows gains and loses only the rows that changed, so that two people's changes are both kept. */
function writeAttribute(node: YMap, key: Attribute, v: unknown): void {
  if (key !== 'hidden') {
    if (v === undefined) node.delete(key);
    else node.set(key, v);
    return;
  }
  const rows = new Set((v as string[] | undefined) ?? []);
  let m = node.get(key);
  if (!(m instanceof Y.Map)) node.set(key, (m = new Y.Map<unknown>()));
  const held = m as YMap;
  for (const row of [...held.keys()]) if (!rows.has(row)) held.delete(row);
  for (const row of rows) if (!held.has(row)) held.set(row, true);
}

/** What a kind of node holds besides its text and attributes, each read and written its own way. */
const PARTS: Partial<Record<SharedType, { read(node: YMap): Record<string, unknown>; write(node: YMap, n: Node): void }>> = {
  device: {
    read(node) {
      const held = node.get('ports');
      const ports = held instanceof Y.Map ? inOrder(held as YMap, (id, p) => ({ id, name: textOf(p.get('name')), side: p.get('side'), signal: p.get('signal') }) as Port) : [];
      return { note: textOf(node.get('note')), ports };
    },
    write(node, n) {
      if (n.type !== 'device') return;
      node.set('note', new Y.Text(n.note));
      const ports = new Y.Map<unknown>();
      node.set('ports', ports);
      n.ports.forEach((p, i) => putPort(ports, p, i));
    },
  },
  legend: {
    read(node) {
      const held = node.get('names');
      if (!(held instanceof Y.Map) || !held.size) return { names: undefined };
      const names: Record<string, string> = {};
      (held as YMap).forEach((name, row) => (names[row] = textOf(name)));
      return { names };
    },
    write(node, n) {
      if (n.type !== 'legend') return;
      const names = new Y.Map<unknown>();
      node.set('names', names);
      for (const [row, name] of Object.entries(n.names ?? {})) names.set(row, new Y.Text(name));
    },
  },
};

/** A node as the drawing reads it; null for a node of a kind this version does not share, or one not whole. */
export function nodeOf(id: string, node: YMap): Node | null {
  const type = node.get('type');
  if (!isShared(type)) return null;
  const pos = pair(node.get('pos'), 'x', 'y');
  const size = pair(node.get('size'), 'w', 'h');
  if (!pos || !size) return null;
  const out: Record<string, unknown> = { id, type, x: pos[0], y: pos[1], w: size[0], h: size[1], text: textOf(node.get('text')), ...DEFAULTS[type] };
  for (const key of ATTRIBUTES[type]) {
    const v = readAttribute(node, key);
    if (v !== undefined) out[key] = v;
  }
  const read = { ...out, ...PARTS[type]?.read(node) } as unknown as Node;
  // Made whole as a device read from a file is, so that one comes out the same on either.
  return read.type === 'device' ? wholeDevice(read) : read;
}

/** Write a new node into a board's nodes. */
function putNode(nodes: YMap, n: Node, order: number): void {
  const type = n.type as SharedType;
  const node = new Y.Map<unknown>();
  nodes.set(n.id, node);
  node.set('id', n.id);
  node.set('type', type);
  node.set('order', order);
  node.set('pos', { x: n.x, y: n.y });
  node.set('size', { w: n.w, h: n.h });
  node.set('text', new Y.Text(n.text));
  const v = n as unknown as Record<string, unknown>;
  // A set of rows is made with the node even when empty: two people making it at once would each make one, and one would be lost.
  for (const key of ATTRIBUTES[type]) if (key === 'hidden' || v[key] !== undefined) writeAttribute(node, key, v[key]);
  PARTS[type]?.write(node, n);
}

/** Change attributes of a node in place, each on its own: what others changed beside them stays. */
function changeNode(node: YMap, change: Change): void {
  if ('x' in change) node.set('pos', { x: change.x, y: change.y });
  if ('w' in change) node.set('size', { w: change.w, h: change.h });
  for (const [key, v] of Object.entries(change)) if (key !== 'x' && key !== 'y' && key !== 'w' && key !== 'h') writeAttribute(node, key as Attribute, v);
}

/** Write a new port into a device's ports. */
function putPort(ports: YMap, p: Port, order: number): void {
  const port = new Y.Map<unknown>();
  ports.set(p.id, port);
  port.set('id', p.id);
  port.set('name', new Y.Text(p.name));
  port.set('side', p.side);
  port.set('signal', p.signal);
  port.set('order', order);
}

/** Put ports on a device, change and take off ports of it: as writeNodes does nodes. New ports go after the rest. */
function writePorts(node: YMap, edit: Items<Port>): void {
  const ports = node.get('ports');
  if (!(ports instanceof Y.Map)) return;
  const held = ports as YMap;
  for (const id of edit.remove) held.delete(id);
  for (const [id, change] of edit.set) {
    const port = held.get(id);
    if (port instanceof Y.Map) for (const [key, v] of Object.entries(change)) port.set(key, v);
  }
  let { front } = orderRange(held);
  for (const p of edit.add) if (!held.has(p.id)) putPort(held, p, ++front);
}

/**
 * Write the nodes and ports of an edit into a board's nodes (within the caller's transaction). A
 * change to a node or a port no longer there is dropped, never bringing it back; one put there under
 * an id already taken is not written over what holds it. Nodes put beneath the rest keep their
 * order, the first furthest back (as withEdit shows them).
 */
export function writeNodes(nodes: YMap, edit: BoardEdit): void {
  const range = orderRange(nodes);
  let front = range.front;
  let below = range.back - edit.add.filter((x) => x.back).length;
  for (const id of edit.remove) nodes.delete(id);
  for (const [id, change] of edit.set) {
    const node = nodes.get(id);
    if (node instanceof Y.Map) changeNode(node, change);
  }
  for (const [id, ports] of edit.ports) {
    const node = nodes.get(id);
    if (node instanceof Y.Map) writePorts(node, ports);
  }
  for (const { node, back: under } of edit.add) {
    if (nodes.has(node.id)) continue;
    putNode(nodes, node, under ? below++ : ++front);
  }
}
