import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { center, nodeAt, nodeRect, portPos } from '../src/model/geometry';
import { allIds } from '../src/model/ids';
import { cableTable, clearOrder, equipmentTable, moveRow } from '../src/model/lists';
import { toYaml } from '../src/model/dsl';
import { makeDevice, makeNode, presetOf } from '../src/model/presets';
import type { DeviceNode, Doc, EdgeEnd, Node, Pt } from '../src/model/types';
import { type RunningServer, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
const sessions: Session[] = [];
/** How the canvas plans a line: loaded once the page is stubbed, as the store it reads is. */
let plans: typeof import('../src/canvas/connect');

beforeEach(async () => {
  stubPage({ realTimers: true });
  ({ data, seed, token } = seedData('system'));
  server = await startServer(data);
  plans = await import('../src/canvas/connect');
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** An editor with its own local boards, showing the shared project's system board. */
async function editor() {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession();
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: server.url, project: seed.id, token });
  const s = () => session.useStore.getState();
  const node = (id: string) => s().doc.nodes.find((n) => n.id === id);
  /** Put a node on the board as the toolbar does: made with ids from what is on the board, in one step. */
  const add = <T extends Node>(make: (taken: Set<string>) => T): T => {
    let made: T | undefined;
    s().mutate((d) => {
      made = make(allIds(d));
      return { ...d, nodes: [...d.nodes, made] };
    });
    return made!;
  };
  /** Bring the nodes to the front or send them to the back, as the context menu does. */
  const restack = (picked: string[], where: 'front' | 'back') => {
    s().select(picked);
    session.restack(where);
  };
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { session, s, node, add, restack, stored };
}

type Editor = Awaited<ReturnType<typeof editor>>;

/** Kill the server outright, start it again over the same data, and open the project in a new editor. */
async function afterRestart(): Promise<Editor> {
  await server.kill();
  server = await startServer(data);
  return editor();
}

const ids = (x: Editor) => x.s().doc.nodes.map((n) => n.id);

/** Wait until both editors' edits are stored and both show the board alike. */
async function agree(a: Editor, b: Editor): Promise<void> {
  await a.stored();
  await b.stored();
  await until(() => JSON.stringify(a.s().doc) === JSON.stringify(b.s().doc), 5_000, 'the two editors to agree');
}

/** A device's port by its name, as an end of a line. */
function portOf(x: Editor, device: string, name: string): EdgeEnd {
  const port = (x.node(device) as DeviceNode).ports.find((p) => p.name === name);
  if (!port) throw new Error(`no port ${name} on ${device}`);
  return { node: device, port: port.id };
}

/** A device's ports on one side, in their order. */
const portsOn = (x: Editor, device: string, side: 'left' | 'right') => (x.node(device) as DeviceNode).ports.filter((p) => p.side === side);
const portNames = (x: Editor, device: string, side: 'left' | 'right') => portsOn(x, device, side).map((p) => p.name);
const portIds = (x: Editor, device: string, side: 'left' | 'right') => portsOn(x, device, side).map((p) => p.id);

/** Pull a line from `from` and let go on the body of `onto`, as the canvas does. Returns the line's id. */
function connect(x: Editor, from: EdgeEnd, onto: string): string {
  const at = { x: 0, y: 0 };
  const plan = plans.planConnect(x.s().doc, { kind: 'connect', from, at, sx: 0, sy: 0, trail: [at] }, center(nodeRect(x.node(onto)!)), 1);
  if (!plan) throw new Error(`no line from ${from.node} onto ${onto}`);
  x.s().setDoc(plan.doc);
  return plan.edge;
}

/** Move a device's port one place up or down among the ports on its side, as the inspector's ↑↓ do. */
function movePort(x: Editor, { node: device, port: id }: EdgeEnd, step: -1 | 1): void {
  const ports = (x.node(device) as DeviceNode).ports;
  const port = ports.find((p) => p.id === id)!;
  const same = ports.filter((p) => p.side === port.side);
  const other = same[same.indexOf(port) + step];
  x.s().updateNode(device, { ports: ports.map((p) => (p === port ? other : p === other ? port : p)) });
}

/** Take a port off a device as the inspector does: with the lines on it, in one step. */
function removePort(x: Editor, { node: device, port: id }: EdgeEnd): void {
  const on = (end: EdgeEnd) => end.node === device && end.port === id;
  x.s().mutate((d) => ({
    ...d,
    nodes: d.nodes.map((n) => (n.id === device && n.type === 'device' ? { ...n, ports: n.ports.filter((p) => p.id !== id) } : n)),
    edges: d.edges.filter((e) => !on(e.from) && !on(e.to)),
  }));
}

/** Drag a row of the equipment list to another place, as the lists panel does. */
const moveDeviceRow = (x: Editor, from: number, to: number) => x.s().setDoc(moveRow(x.s().doc, equipmentTable(x.s().doc), from, to));
/** The devices behind each row of the equipment list (its total left out), in the order listed. */
const deviceRows = (doc: Doc) => equipmentTable(doc).refs.filter((row) => row.length);

describe('the order of a shared board', () => {
  it('draws and picks the same node at a point on both editors when one brings a node to the front and the other sends one to the back and adds one there at once, through undo and a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const shape = seed.shape.id;
    // Over the shape (0, 0, 160 × 80), one on the other: the shape is drawn first, the ellipse last.
    const box = a.add((t) => makeNode('rect', 80, 40, t));
    const ellipse = a.add((t) => makeNode('ellipse', 80, 40, t));
    await until(() => !!b.node(ellipse.id), 5_000, 'the nodes to reach the other editor');
    const middle: Pt = { x: 80, y: 40 };
    expect(nodeAt(b.s().doc, middle)?.id).toBe(ellipse.id);

    a.restack([shape], 'front');
    b.restack([ellipse.id], 'back');
    const diamond = b.add((t) => makeNode('diamond', 80, 40, t));
    await agree(a, b);

    expect(ids(a)).toEqual(ids(b));
    expect(new Set(ids(a))).toEqual(new Set([shape, box.id, ellipse.id, diamond.id]));
    // In front of what its editor saw, behind all: each move kept, whatever the other did meanwhile.
    expect(ids(a)[0]).toBe(ellipse.id);
    expect(ids(a).indexOf(shape)).toBeGreaterThan(ids(a).indexOf(box.id));
    expect(nodeAt(a.s().doc, middle)?.id).toBe(nodeAt(b.s().doc, middle)?.id);

    // Undoing the move puts the shape back where it was among the others; the other editor's edits stay.
    a.s().undo();
    await agree(a, b);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a).slice(0, 3)).toEqual([ellipse.id, shape, box.id]);
    expect(ids(a)).toContain(diamond.id);

    const c = await afterRestart();
    expect(ids(c)).toEqual(ids(a));
    expect(toYaml(c.s().doc)).toEqual(toYaml(a.s().doc));
  });

  it("keeps a line connected to a port the other editor moves among the device's ports at once, the ports in one order on both boards and in the cable table, through a killed server", async () => {
    const a = await editor();
    const b = await editor();
    const pc = a.add((t) => makeDevice(presetOf('pc')!, 0, 300, t)).id;
    const pj = a.add((t) => makeDevice(presetOf('pj')!, 600, 300, t)).id;
    const led = a.add((t) => makeDevice(presetOf('led')!, 600, 700, t)).id;
    await until(() => !!b.node(led), 5_000, 'the devices to reach the other editor');
    const hdmi = portOf(a, pc, 'HDMI 1');

    // At once: one moves the PC's HDMI 1 below HDMI 2 and the LED wall's AC above DATA; the other
    // connects HDMI 1 to the projector, and HDMI 2 to the LED wall, which makes it a port of its own.
    movePort(a, hdmi, 1);
    movePort(a, portOf(a, led, 'AC'), -1);
    const toPj = connect(b, hdmi, pj);
    const toLed = connect(b, portOf(b, pc, 'HDMI 2'), led);
    await agree(a, b);

    for (const x of [a, b]) {
      expect(portNames(x, pc, 'right')).toEqual(['HDMI 2', 'HDMI 1', 'DP']);
      expect(portNames(x, led, 'left').slice(0, 2)).toEqual(['AC', 'DATA']);
      expect(portNames(x, led, 'left')).toHaveLength(3);
      expect(x.s().doc.edges.find((e) => e.id === toPj)?.from).toEqual(hdmi);
      expect(x.s().doc.edges.find((e) => e.id === toLed)?.to.node).toBe(led);
    }
    expect(b.s().doc.nodes).toEqual(a.s().doc.nodes);
    expect(portPos(b.node(pc) as DeviceNode, hdmi.port!)).toEqual(portPos(a.node(pc) as DeviceNode, hdmi.port!));
    expect(cableTable(b.s().doc).rows).toEqual(cableTable(a.s().doc).rows);

    const c = await afterRestart();
    expect(c.s().doc.nodes).toEqual(a.s().doc.nodes);
    expect(cableTable(c.s().doc).rows).toEqual(cableTable(a.s().doc).rows);
  });

  it('orders ports put on one device at once alike, and a move and a removal among them made at once', async () => {
    const a = await editor();
    const b = await editor();
    const pcs = [a.add((t) => makeDevice(presetOf('pc')!, 0, 300, t)).id, a.add((t) => makeDevice(presetOf('pc')!, 0, 700, t)).id];
    const led = a.add((t) => makeDevice(presetOf('led')!, 600, 500, t)).id;
    await until(() => !!b.node(led), 5_000, 'the devices to reach the other editor');

    // Both connect to the LED wall at once: two video inputs put there at one place.
    connect(a, portOf(a, pcs[0], 'HDMI 1'), led);
    connect(b, portOf(b, pcs[1], 'HDMI 1'), led);
    await agree(a, b);
    const [data, ac, one, two] = portIds(a, led, 'left');
    expect(portIds(b, led, 'left')).toEqual([data, ac, one, two]);
    expect(portNames(a, led, 'left').slice(0, 2)).toEqual(['DATA', 'AC']);

    // At once: one moves the last input up past the other new one, the other takes AC off.
    movePort(a, { node: led, port: two }, -1);
    removePort(b, { node: led, port: ac });
    await agree(a, b);

    expect(portIds(a, led, 'left')).toEqual([data, two, one]);
    // Each line left ends on a port the LED wall still has.
    const kept = new Set((a.node(led) as DeviceNode).ports.map((p) => p.id));
    for (const e of a.s().doc.edges) expect(kept.has(e.to.port!)).toBe(true);
    expect(cableTable(b.s().doc).rows).toEqual(cableTable(a.s().doc).rows);
  });

  it('lists the rows of a list in one order when two editors drag rows, or one drags and the other drops the order, at once, never losing or doubling a row, through undo and a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const devices = ['pc', 'pj', 'led', 'conv', 'sw'].map((key, i) => a.add((t) => makeDevice(presetOf(key)!, 0, i * 300, t)).id);
    await until(() => devices.every((id) => !!b.node(id)), 5_000, 'the devices to reach the other editor');
    const first = deviceRows(a.s().doc);
    expect(first.flat().sort()).toEqual([...devices].sort());

    // One puts the list in order by hand; the other sees it.
    moveDeviceRow(a, 0, 4);
    await agree(a, b);
    const byHand = deviceRows(a.s().doc);
    expect(byHand).toEqual([...first.slice(1), first[0]]);
    expect(deviceRows(b.s().doc)).toEqual(byHand);

    // At once, each drags a row of its own.
    moveDeviceRow(a, 0, 2);
    moveDeviceRow(b, 3, 0);
    await agree(a, b);
    expect(deviceRows(a.s().doc)).toEqual([first[4], first[2], first[3], first[1], first[0]]);

    // Undoing a drag puts back the row this editor moved; the other's stays.
    a.s().undo();
    await agree(a, b);
    expect(deviceRows(a.s().doc)).toEqual([first[4], first[1], first[2], first[3], first[0]]);

    // At once, one drags a row and the other drops the order put by hand: the row dragged meanwhile
    // keeps its place, the rest go back to the list's own order.
    moveDeviceRow(a, 2, 0);
    b.s().setDoc(clearOrder(b.s().doc, 'equipment'));
    await agree(a, b);
    expect(deviceRows(a.s().doc)).toEqual([first[2], first[0], first[1], first[3], first[4]]);

    const c = await afterRestart();
    expect(deviceRows(c.s().doc)).toEqual(deviceRows(a.s().doc));
    expect(toYaml(c.s().doc)).toEqual(toYaml(a.s().doc));
  });

  it('keeps both drags made at once when one drags a row between two rows dragged to one place before, and the other drags another row', async () => {
    const a = await editor();
    const b = await editor();
    const devices = ['pc', 'pj', 'led', 'conv', 'sw'].map((key, i) => a.add((t) => makeDevice(presetOf(key)!, 0, i * 300, t)).id);
    await until(() => devices.every((id) => !!b.node(id)), 5_000, 'the devices to reach the other editor');
    moveDeviceRow(a, 0, 4);
    await agree(a, b);
    // At once, both drag a row to between the first two: the two stand at one place.
    moveDeviceRow(a, 3, 1);
    moveDeviceRow(b, 2, 1);
    await agree(a, b);
    const [first, one, two, second, last] = deviceRows(a.s().doc);

    // At once: one drags the last row to between those two, the other drags the first row to after the second.
    moveDeviceRow(a, 4, 2);
    moveDeviceRow(b, 0, 3);
    await agree(a, b);
    expect(deviceRows(a.s().doc)).toEqual([one, last, two, second, first]);
  });
});
