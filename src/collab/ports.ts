import * as Y from 'yjs';
import type { Port } from '../model/types';
import type { Items } from './edits';
import { type YMap, readInOrder, setEach, textOf, writeItems } from './entries';

/**
 * A device's ports as the project holds them (see nodes.ts for the device):
 *
 * ports: Y.Map<port id, Y.Map { id, name: Y.Text, side, signal, order }>
 *
 * Each port is an entry of its own, so ports two people add to one device at once are both kept, and
 * its side and signal are keys of their own (see PORT_ATTRIBUTES in scope.ts). Its name is typed by
 * hand: a Y.Text.
 */

/** A device's ports, in their order. */
export function readPorts(node: YMap): Port[] {
  const ports = node.get('ports');
  return ports instanceof Y.Map ? readInOrder(ports as YMap, (id, p) => ({ id, name: textOf(p.get('name')), side: p.get('side'), signal: p.get('signal') }) as Port) : [];
}

function putPort(ports: YMap, p: Port, order: number): void {
  const port = new Y.Map<unknown>();
  ports.set(p.id, port);
  port.set('id', p.id);
  port.set('name', new Y.Text(p.name));
  port.set('side', p.side);
  port.set('signal', p.signal);
  port.set('order', order);
}

/** Give a device being put on the board its ports. */
export function putPorts(node: YMap, ports: Port[]): void {
  const held = new Y.Map<unknown>();
  node.set('ports', held);
  ports.forEach((p, i) => putPort(held, p, i));
}

/** Put ports on a device, change and take off ports of it (see writeItems). */
export function writePorts(node: YMap, edit: Items<Port>): void {
  const ports = node.get('ports');
  if (ports instanceof Y.Map) writeItems(ports as YMap, edit, setEach, putPort);
}
