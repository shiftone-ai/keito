import * as Y from 'yjs';
import { uuid } from '../model/ids';
import { DEVICE_FIELDS, hostName } from '../model/shared';
import type { DeviceAt } from '../model/target';
import type { DeviceNode } from '../model/types';
import { boardNodes } from './boards';
import { type YMap, isString, setEach, textOf } from './entries';

/**
 * The project's shared devices (see model.ts for the rest of the Y.Doc):
 *
 * devices: Y.Map<key, Y.Map { text: Y.Text, maker, model, category, url, ip, host }>
 *
 * A device on several boards of the project is one shared device. Its name and the particulars of
 * SHARED are kept here once; each device placed on a board from it names it under `shared` and keeps
 * the rest as its own (where it is, its ports, note, colour …). Software names the shared device it
 * runs on under `runsOn`, and takes its host name and IP from it as it is now. A device placed from a
 * shared device the project no longer has is left out of the drawing, as a line whose end is gone is
 * (see valid.ts); software running on one has no host, never another device's.
 */

const DEVICES = 'devices';

type Particular = Exclude<(typeof DEVICE_FIELDS)[number], 'text'>;
/** What a shared device holds besides its name: each set whole, a key of its own. */
const SHARED = DEVICE_FIELDS.filter((k): k is Particular => k !== 'text');

/**
 * What makes a device of a board one with a shared device, or no longer (see writeLink): linking it
 * to a device of another board, unlinking it, having software run on a device of another board (or
 * none), and deleting a shared device from every board.
 */
export type DeviceLink =
  | { type: 'link'; node: string; to: DeviceAt }
  | { type: 'unlink'; node: string }
  | { type: 'runOn'; node: string; host: DeviceAt | null }
  | { type: 'delete'; device: string };

/** The device of another board a link makes the device one with, or runs it on; null for none. */
export const linkedTo = (link: DeviceLink): DeviceAt | null => (link.type === 'link' ? link.to : link.type === 'runOn' ? link.host : null);

export const sharedDevices = (ydoc: Y.Doc): YMap => ydoc.getMap<unknown>(DEVICES);

/** The shared devices of the project a board's node is in; none for a node in no project. */
const devicesOf = (node: YMap): YMap | null => (node.doc ? sharedDevices(node.doc) : null);

/** The shared device under `key`; null for a key the project has no shared device under. */
function sharedOf(devices: YMap | null, key: unknown): YMap | null {
  const record = isString(key) ? devices?.get(key as string) : undefined;
  return record instanceof Y.Map ? (record as YMap) : null;
}

/** The particulars a device always has: '' when not set. */
const ALWAYS = new Set<string>(['maker', 'model', 'category']);

/** A shared device's name and particulars, as a device shows them: each of them, set or not, so that none of the device's own shows through. */
function particularsOf(record: YMap): Pick<DeviceNode, 'text' | Particular> {
  const out: Record<string, unknown> = { text: textOf(record.get('text')) };
  for (const key of SHARED) {
    const v = record.get(key);
    out[key] = isString(v) ? v : ALWAYS.has(key) ? '' : undefined;
  }
  return out as Pick<DeviceNode, 'text' | Particular>;
}

/** The host name and IP of software running on a shared device: the device's host name, else the first line of its name. */
function hostOf(record: YMap | null): Pick<DeviceNode, 'host' | 'ip'> {
  if (!record) return { host: undefined, ip: undefined };
  const particulars = particularsOf(record);
  return { host: hostName(particulars), ip: particulars.ip };
}

/**
 * What a device node shows of the project's shared devices: the name and particulars of the one it
 * is placed from (and its key), and the host name and IP of the one it runs on (and its key). Null
 * for one placed from a shared device the project does not have: it is no device of the drawing.
 */
export function readLinks(node: YMap): Partial<DeviceNode> | null {
  const devices = devicesOf(node);
  const out: Partial<DeviceNode> = {};
  const shared = node.get('shared');
  if (isString(shared)) {
    const record = sharedOf(devices, shared);
    if (!record) return null;
    Object.assign(out, particularsOf(record), { shared });
  }
  const runsOn = node.get('runsOn');
  if (isString(runsOn)) Object.assign(out, hostOf(sharedOf(devices, runsOn)), { runsOn });
  return out;
}

/** The shared device a device node is placed from; null for one of its own. */
export const placedFrom = (node: YMap): YMap | null => sharedOf(devicesOf(node), node.get('shared'));

/** Whether a device placed from a shared device shows the shared device's value of `key` (its name, a particular) rather than its own. */
export const isParticular = (key: string): boolean => key === 'text' || (SHARED as readonly string[]).includes(key);

/** Set the name or a particular of a shared device (undefined takes a particular off). */
export function writeShared(record: YMap, key: string, v: unknown): void {
  if (key === 'text') {
    const text = record.get('text');
    if (text instanceof Y.Text) retype(text, typeof v === 'string' ? v : '');
  } else setEach(record, { [key]: v });
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Turn a text into `to` by taking out and putting in only what lies between the part at its start
 * and the part at its end that stay: what others typed beside it is kept.
 */
function retype(text: Y.Text, to: string): void {
  const from = text.toString();
  if (from === to) return;
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  // Never between the two halves of a character: Yjs would put a replacement character for each.
  if (start > 0 && isHigh(from.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  if (end > 0 && isLow(from.charCodeAt(from.length - end))) end--;
  text.delete(start, from.length - start - end);
  text.insert(start, to.slice(start, to.length - end));
}

/** A device of a board by its id; null when gone, or placed from a shared device the project no longer has. */
function deviceIn(nodes: YMap | null, id: string): YMap | null {
  const node = nodes?.get(id);
  if (!(node instanceof Y.Map) || node.get('type') !== 'device') return null;
  return isString(node.get('shared')) && !placedFrom(node as YMap) ? null : (node as YMap);
}

/** A device placed from a shared device: it names it, and keeps none of its particulars as its own. */
function placeFrom(node: YMap, key: string): void {
  node.set('shared', key);
  node.delete('text');
  for (const k of SHARED) node.delete(k);
}

/** Software running on a shared device: it names it, and keeps no host name or IP of its own. */
function runOn(node: YMap, key: string): void {
  node.set('runsOn', key);
  node.delete('host');
  node.delete('ip');
}

/**
 * The key of the shared device the device at `at` is placed from; when it has none yet, the key of a
 * new shared device made of its name and particulars (which writeLink places it from). Null when it
 * is gone.
 */
export function shareKey(ydoc: Y.Doc, at: DeviceAt): string | null {
  const node = deviceIn(boardNodes(ydoc, at.board), at.node);
  if (!node) return null;
  const placed = node.get('shared');
  if (isString(placed)) return placed as string;
  const key = uuid();
  const record = new Y.Map<unknown>();
  sharedDevices(ydoc).set(key, record);
  record.set('text', new Y.Text(textOf(node.get('text'))));
  for (const k of SHARED) {
    const v = node.get(k);
    if (isString(v)) record.set(k, v);
  }
  return key;
}

/**
 * Write a link of a device of a board (`nodes`) into the project (within the caller's transaction).
 * Linked to a device of another board (or running on one), both are placed from the shared device
 * under `key` (see shareKey), whose particulars they then show. Unlinked, the device keeps what it
 * showed of the shared device as its own; neither the other devices placed from it nor any other
 * shared device change. Software stopped running on a device keeps the host name and IP it showed,
 * in the shared software it is placed from if any. A link of a device no longer there, or to one,
 * is dropped. Deleting a shared device leaves out of the drawing every device placed from it, with
 * the lines to them (see readLinks).
 */
export function writeLink(ydoc: Y.Doc, nodes: YMap, link: DeviceLink, key: string | null): void {
  const devices = sharedDevices(ydoc);
  if (link.type === 'delete') return void devices.delete(link.device);
  const node = deviceIn(nodes, link.node);
  if (!node) return;
  const there = linkedTo(link);
  if (there) {
    const other = deviceIn(boardNodes(ydoc, there.board), there.node);
    if (!other || !key || !sharedOf(devices, key)) return;
    if (other.get('shared') !== key) placeFrom(other, key);
    (link.type === 'link' ? placeFrom : runOn)(node, key);
  } else if (link.type === 'unlink') {
    const record = placedFrom(node);
    if (!record) return;
    const { text, ...particulars } = particularsOf(record);
    node.set('text', new Y.Text(text));
    setEach(node, particulars);
    node.delete('shared');
  } else if (isString(node.get('runsOn'))) {
    // Not on the node alone: placed from shared software, the node shows the shared software's.
    setEach(placedFrom(node) ?? node, hostOf(sharedOf(devices, node.get('runsOn'))));
    node.delete('runsOn');
  }
}

/**
 * A device just put on a board (from a copy, say) that names shared devices: placed from the one it
 * names and running on the other only where the project has them. One it does not have (copied from
 * a board of this machine, or deleted meanwhile) is not named: what the device shows is its own.
 */
export function putLinks(node: YMap, n: DeviceNode): void {
  const devices = devicesOf(node);
  if (n.shared && sharedOf(devices, n.shared)) placeFrom(node, n.shared);
  if (n.runsOn && sharedOf(devices, n.runsOn)) runOn(node, n.runsOn);
}
