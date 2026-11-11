import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { nodeRect } from '../src/model/geometry';
import { allIds, freshId } from '../src/model/ids';
import { cableTable } from '../src/model/lists';
import { JUNCTION, makeDevice, makeLegend, makeNode, presetOf } from '../src/model/presets';
import type { DeviceNode, Doc, EdgeEnd, Node, Pt } from '../src/model/types';
import { type RunningServer, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
let page: ReturnType<typeof stubPage>;
const sessions: Session[] = [];

beforeEach(async () => {
  page = stubPage({ realTimers: true });
  ({ data, seed, token } = seedData('system'));
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** An editor with its own local boards, showing the shared project's system board; `page`: the one listening to the page closing. */
async function editor(options: { page?: boolean } = {}) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession(options);
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
  /** Change something about a node as the canvas does while dragging: an operation begun, steps shown, ended on letting go. */
  const drag = (id: string, to: Partial<Node>) => {
    s().checkpoint();
    const from = node(id)!;
    const half = Object.fromEntries(Object.entries(to).map(([k, v]) => [k, (Number(v) + Number(from[k as keyof Node])) / 2]));
    s().updateNode(id, half, false);
    s().updateNode(id, to, false);
    s().commitOperation();
  };
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { session, disk, s, node, add, drag, stored };
}

/** Kill the server outright, start it again over the same data, and open the project in a new editor. */
async function afterRestart() {
  await server.kill();
  server = await startServer(data);
  return editor();
}

const ids = (doc: Doc) => doc.nodes.map((n) => n.id);
const at = (n: Node | undefined) => n && { x: n.x, y: n.y };
const colorOf = (n: Node | undefined) => (n as { color?: string } | undefined)?.color;
const shape = () => seed.shape.id;

describe('basic edits of a shared board', () => {
  it('keeps both nodes two editors put on the board at once, the same name under ids of their own, through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const pj = presetOf('pj')!;
    const boxes = [a.add((t) => makeNode('rect', 100, 100, t)), b.add((t) => makeNode('rect', 100, 100, t))];
    const devices = [a.add((t) => makeDevice(pj, 300, 0, t)), b.add((t) => makeDevice(pj, 300, 0, t))];
    expect(new Set([...boxes, ...devices].map((n) => n.id)).size).toBe(4);

    await until(() => a.s().doc.nodes.length === 5 && b.s().doc.nodes.length === 5, 5_000, 'both editors to have all five nodes');
    expect(ids(b.s().doc)).toEqual(ids(a.s().doc));
    expect(devices.map((d) => b.node(d.id)?.text)).toEqual(['プロジェクター', 'プロジェクター']);
    await a.stored();
    await b.stored();

    const c = await afterRestart();
    expect(ids(c.s().doc)).toEqual(ids(a.s().doc));
  });

  it('shows every kind of node the other editor puts on the board as it was put there', async () => {
    const a = await editor();
    const b = await editor();
    const made = [
      a.add((t) => ({ ...makeNode('round', 0, 200, t, 'ステージ'), color: 'blue', fill: 'solid', dash: true, fontSize: 18, bold: true })),
      a.add((t) => ({ ...makeNode('sticky', 200, 200, t, '確認する'), done: true })),
      a.add((t) => makeNode('text', 400, 200, t, '注記')),
      a.add((t) => ({ ...makeDevice(presetOf('switcher')!, 0, 400, t), maker: 'Blackmagic', model: 'ATEM', ip: '192.168.0.10', host: 'atem', watts: 30, qty: 2, vendor: 'レンタル', venue: true, color: 'green' } as DeviceNode)),
      a.add((t) => ({ id: freshId(t, 'j'), type: 'junction', x: 600, y: 400, w: JUNCTION, h: JUNCTION, text: '' }) as Node),
      a.add((t) => ({ ...makeLegend(t, 600, 0), hidden: ['#ff0000'] }) as Node),
    ];
    // Areas go beneath what they hold, as the toolbar puts them.
    const area = makeNode('frame', 0, 0, allIds(a.s().doc));
    a.s().mutate((d) => ({ ...d, nodes: [area, ...d.nodes] }));

    await until(() => b.s().doc.nodes.length === 8, 5_000, 'the nodes to reach the other editor');
    expect(ids(a.s().doc)).toEqual(ids(b.s().doc));
    expect(b.s().doc.nodes[0]).toEqual(area);
    // A legend is as tall as its rows on each screen.
    for (const n of made) expect(n.type === 'legend' ? { ...b.node(n.id), h: n.h } : b.node(n.id)).toEqual(n);
    await a.stored();

    const c = await afterRestart();
    expect(c.s().doc.nodes).toEqual(b.s().doc.nodes);
  });

  it('keeps a move by one editor and a change of other attributes by the other, made at once', async () => {
    const a = await editor();
    const b = await editor();
    const device = a.add((t) => makeDevice(presetOf('pc')!, 300, 0, t));
    await until(() => !!b.node(device.id), 5_000, 'the device to reach the other editor');

    a.drag(shape(), { x: 240, y: 120 });
    b.s().updateNode(shape(), { color: 'blue' });
    a.drag(device.id, { x: 500, y: 300 });
    b.s().updateNode(device.id, { ip: '10.0.0.5', maker: 'Apple' });

    for (const x of [a, b]) {
      await until(() => colorOf(x.node(shape())) === 'blue' && x.node(shape())?.x === 240 && (x.node(device.id) as DeviceNode | undefined)?.ip === '10.0.0.5' && x.node(device.id)?.x === 500, 5_000, 'both changes on each editor');
      expect(x.node(shape())).toMatchObject({ x: 240, y: 120, color: 'blue' });
      expect(x.node(device.id)).toMatchObject({ x: 500, y: 300, ip: '10.0.0.5', maker: 'Apple' });
    }
  });

  it('ends with one place for a node two editors move at once', async () => {
    const a = await editor();
    const b = await editor();
    a.drag(shape(), { x: 100, y: 0 });
    b.drag(shape(), { x: 0, y: 100 });
    await a.stored();
    await b.stored();
    await until(() => JSON.stringify(at(a.node(shape()))) === JSON.stringify(at(b.node(shape()))), 5_000, 'the two editors to agree');
    expect([{ x: 100, y: 0 }, { x: 0, y: 100 }]).toContainEqual(at(a.node(shape())));
  });

  it("undoes this editor's own edits one operation at a time, keeping what the other editor did", async () => {
    const a = await editor();
    const b = await editor();
    expect(a.s().collab?.undo).toBe(false);
    a.drag(shape(), { x: 240, y: 120 });
    a.drag(shape(), { w: 300, h: 200 });
    b.s().updateNode(shape(), { color: 'green' });
    const mine = a.add((t) => makeNode('ellipse', 0, 300, t));
    const theirs = b.add((t) => makeNode('diamond', 300, 300, t));
    await until(() => !!a.node(theirs.id) && colorOf(a.node(shape())) === 'green', 5_000, "the other editor's edits to arrive");
    // What the other editor did is no reason to forget what this one did.
    expect(a.s().collab?.undo).toBe(true);

    // Each step is waited for on the other editor, not only the last: on the way there, it shows a
    // state that looks like the end (the shape at x 240 still with its new size).
    const reaches = (seen: () => boolean, step: string) => until(seen, 5_000, `${step} to reach the other editor`);
    a.s().undo();
    expect(a.node(mine.id)).toBeUndefined();
    expect(a.node(theirs.id)).toBeDefined();
    await reaches(() => !b.node(mine.id), 'the first undo');
    a.s().undo();
    expect(a.node(shape())).toMatchObject({ x: 240, y: 120, w: 160, h: 80, color: 'green' });
    await reaches(() => b.node(shape())?.w === 160, 'the second undo');
    a.s().undo();
    expect(a.node(shape())).toMatchObject({ x: 0, y: 0, color: 'green' });
    expect(a.s().collab?.undo).toBe(false);
    await reaches(() => b.node(shape())?.x === 0, 'the third undo');
    a.s().redo();
    expect(a.node(shape())).toMatchObject({ x: 240, y: 120, color: 'green' });
    await reaches(() => b.node(shape())?.x === 240, 'the redo');

    expect(b.node(shape())).toMatchObject({ x: 240, y: 120, w: 160, h: 80, color: 'green' });
    expect(b.node(theirs.id)).toBeDefined();
    b.s().undo();
    b.s().undo();
    expect(b.node(shape())).toMatchObject({ x: 240, y: 120, color: 'white' });
    expect(b.node(theirs.id)).toBeUndefined();
    await a.stored();
    await b.stored();

    const c = await afterRestart();
    expect(c.s().doc.nodes).toEqual(b.s().doc.nodes);
  });

  it('takes back a node moved with a key held down in one step, as on a board of this machine', async () => {
    const a = await editor();
    const b = await editor();
    a.drag(shape(), { x: 240, y: 120 });
    // As the arrow keys do: the first press a step of its own, the presses that follow at once part of it.
    const nudge = (record: boolean) => a.s().updateNode(shape(), { x: a.node(shape())!.x + 1 }, record);
    nudge(true);
    nudge(false);
    nudge(false);
    await until(() => b.node(shape())?.x === 243, 5_000, 'the moves to reach the other editor');

    a.s().undo();
    expect(at(a.node(shape()))).toEqual({ x: 240, y: 120 });
    a.s().undo();
    expect(at(a.node(shape()))).toEqual({ x: 0, y: 0 });
  });

  it('sends an edit still under way when the page is closed, the browser asking first until it is stored', async () => {
    const a = await editor({ page: true });
    const b = await editor();
    // A value typed into a field that is not left yet.
    a.s().checkpoint();
    a.s().updateNode(shape(), { color: 'blue' }, false);
    const close = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    page.listeners.beforeunload?.(close);
    expect(close.preventDefault).toHaveBeenCalled();
    await until(() => colorOf(b.node(shape())) === 'blue', 5_000, 'the edit to reach the other editor');
  });

  it('keeps a node taken off by one editor off while the other changes or drags it, through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const device = a.add((t) => makeDevice(presetOf('pc')!, 300, 0, t));
    await until(() => !!b.node(device.id), 5_000, 'the device to reach the other editor');

    // At once: one takes the shape off, the other recolours it.
    a.s().removeIds([shape()]);
    b.s().updateNode(shape(), { color: 'red' });
    // The other is dragging the device when it is taken off.
    b.s().select([device.id]);
    b.s().checkpoint();
    b.s().updateNode(device.id, { x: 400 }, false);
    a.s().removeIds([device.id]);
    await until(() => !b.node(device.id) && !b.node(shape()), 5_000, 'the nodes to go from the other editor');
    expect(b.s().selection).toEqual([]);
    b.s().updateNode(device.id, { x: 500 }, false);
    b.s().commitOperation();
    await a.stored();
    await b.stored();
    for (const x of [a, b]) expect(ids(x.s().doc)).toEqual([]);
    // Nor by undoing what was done to them before they went.
    b.s().undo();
    await b.stored();
    for (const x of [a, b]) expect(ids(x.s().doc)).toEqual([]);

    const c = await afterRestart();
    expect(ids(c.s().doc)).toEqual([]);
  });
});

type Editor = Awaited<ReturnType<typeof editor>>;

/** How the canvas plans a line: loaded once the page is stubbed, as the store it reads is. */
let plans: typeof import('../src/canvas/connect');

/** The middle of a node as the editor sees it: a line let go there lands on the node's body. */
function middle(x: Editor, id: string): Pt {
  const r = nodeRect(x.node(id)!);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Pull a line from `from` and let go on the body of `onto`, as the canvas does. Returns the line's id. */
function connect(x: Editor, from: EdgeEnd, onto: string): string {
  const at = { x: 0, y: 0 };
  const plan = plans.planConnect(x.s().doc, { kind: 'connect', from, at, sx: 0, sy: 0, trail: [at] }, middle(x, onto), 1);
  if (!plan) throw new Error(`no line from ${from.node} onto ${onto}`);
  x.s().setDoc(plan.doc);
  return plan.edge;
}

/** Drag one end of a line onto the body of `onto`, as the canvas does. */
function reconnect(x: Editor, id: string, end: 'from' | 'to', onto: string): void {
  const plan = plans.planReconnect(x.s().doc, { kind: 'reconnect', id, end, other: { x: 0, y: 0 } }, middle(x, onto), 1);
  if (!plan) throw new Error(`no end of ${id} onto ${onto}`);
  x.s().setDoc(plan.doc);
}

/** Take a port off a device as the inspector does: with the lines on it, in one step. */
function removePort(x: Editor, device: string, name: string): void {
  const { port: id } = portOf(x, device, name);
  const on = (end: EdgeEnd) => end.node === device && end.port === id;
  x.s().mutate((d) => ({
    ...d,
    nodes: d.nodes.map((n) => (n.id === device && n.type === 'device' ? { ...n, ports: n.ports.filter((p) => p.id !== id) } : n)),
    edges: d.edges.filter((e) => !on(e.from) && !on(e.to)),
  }));
}

/** A device's port by its name, as an end of a line. */
function portOf(x: Editor, device: string, name: string): EdgeEnd {
  const port = (x.node(device) as DeviceNode).ports.find((p) => p.name === name);
  if (!port) throw new Error(`no port ${name} on ${device}`);
  return { node: device, port: port.id };
}

const line = (x: Editor, id: string) => x.s().doc.edges.find((e) => e.id === id);
const lineIds = (x: Editor) => x.s().doc.edges.map((e) => e.id);

/** Wait until what `from` has sent is on `to`: an edit made after it is seen there (one connection carries both, in order). */
async function caughtUp(from: Editor, to: Editor): Promise<void> {
  const mark = colorOf(from.node(shape())) === 'green' ? 'blue' : 'green';
  from.s().updateNode(shape(), { color: mark });
  await until(() => colorOf(to.node(shape())) === mark, 5_000, 'the other editor to catch up');
}

describe('lines and ports of a shared board', () => {
  beforeEach(async () => {
    plans = await import('../src/canvas/connect');
  });

  /** Two PCs, an LED wall (no video input of its own), a converter and a projector, put on the board by `a` and seen by `b`. */
  async function rack(a: Editor, b: Editor) {
    const put = (key: string, x: number, y: number) => a.add((t) => makeDevice(presetOf(key)!, x, y, t)).id;
    const r = { pc1: put('pc', 0, 300), pc2: put('pc', 0, 700), led: put('led', 600, 300), conv: put('conv', 600, 700), pj: put('pj', 600, 1100) };
    await until(() => Object.values(r).every((id) => !!b.node(id)), 5_000, 'the devices to reach the other editor');
    return r;
  }

  it('keeps both lines two editors connect to one device at once, each into a port of its own, through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const r = await rack(a, b);
    // The LED wall has no video input: each line makes one on it.
    const mine = connect(a, portOf(a, r.pc1, 'HDMI 1'), r.led);
    const theirs = connect(b, portOf(b, r.pc2, 'HDMI 1'), r.led);
    for (const x of [a, b]) await until(() => !!line(x, mine) && !!line(x, theirs), 5_000, 'both lines on each editor');
    await a.stored();
    await b.stored();

    const inputs = (a.node(r.led) as DeviceNode).ports.filter((p) => p.signal === 'video').map((p) => p.id);
    expect(inputs).toHaveLength(2);
    expect([line(a, mine)!.to, line(a, theirs)!.to].map((end) => end.port).sort()).toEqual([...inputs].sort());
    expect(line(a, mine)!.from).toEqual(portOf(a, r.pc1, 'HDMI 1'));
    expect(line(a, theirs)!.from).toEqual(portOf(a, r.pc2, 'HDMI 1'));
    expect(b.s().doc.nodes).toEqual(a.s().doc.nodes);
    expect(b.s().doc.edges).toEqual(a.s().doc.edges);

    const c = await afterRestart();
    expect(c.s().doc.nodes).toEqual(a.s().doc.nodes);
    expect(c.s().doc.edges).toEqual(a.s().doc.edges);
  });

  it('keeps a line one editor pulls onto another device and the cable details the other changes at once', async () => {
    const a = await editor();
    const b = await editor();
    const r = await rack(a, b);
    const id = connect(a, portOf(a, r.pc1, 'HDMI 1'), r.conv);
    await until(() => !!line(b, id), 5_000, 'the line to reach the other editor');

    reconnect(a, id, 'from', r.pc2);
    b.s().updateEdge(id, { cableId: 'V-01', length: 15 });

    for (const x of [a, b]) await until(() => line(x, id)?.from.node === r.pc2 && line(x, id)?.cableId === 'V-01', 5_000, 'both changes on each editor');
    expect(line(a, id)).toMatchObject({ from: portOf(a, r.pc2, 'HDMI 1'), to: portOf(a, r.conv, 'SDI IN'), cableId: 'V-01', length: 15 });
    expect(line(b, id)).toEqual(line(a, id));
  });

  it('ends with the two ends one editor gave a line that both pull at once, never one end from each', async () => {
    const a = await editor();
    const b = await editor();
    const r = await rack(a, b);
    const id = connect(a, portOf(a, r.pc1, 'HDMI 1'), r.conv);
    await until(() => !!line(b, id), 5_000, 'the line to reach the other editor');

    reconnect(a, id, 'from', r.pc2);
    reconnect(b, id, 'to', r.pj);
    await a.stored();
    await b.stored();
    await caughtUp(a, b);
    await caughtUp(b, a);

    expect(line(b, id)).toEqual(line(a, id));
    expect([
      [r.pc2, r.conv],
      [r.pc1, r.pj],
    ]).toContainEqual([line(a, id)!.from.node, line(a, id)!.to.node]);
  });

  it('leaves a line to a device or a port the other editor takes off as it is connected out of the board and the cable table alike, through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const r = await rack(a, b);
    const kept = connect(a, portOf(a, r.pc1, 'HDMI 1'), r.pj);
    await until(() => !!line(b, kept), 5_000, 'the line to reach the other editor');

    // At once: one takes the LED wall and the converter's input off, the other connects a line to each.
    a.s().removeIds([r.led]);
    removePort(a, r.conv, 'SDI IN');
    connect(b, portOf(b, r.pc2, 'HDMI 1'), r.led);
    connect(b, portOf(b, r.pc2, 'HDMI 2'), r.conv);
    await a.stored();
    await b.stored();
    await caughtUp(a, b);
    await caughtUp(b, a);

    for (const x of [a, b]) {
      expect(x.node(r.led)).toBeUndefined();
      expect((x.node(r.conv) as DeviceNode).ports.map((p) => p.name)).not.toContain('SDI IN');
      expect(lineIds(x)).toEqual([kept]);
    }
    expect(cableTable(a.s().doc).rows.at(-1)).toContain('合計 1 本');
    expect(cableTable(b.s().doc)).toEqual(cableTable(a.s().doc));

    const c = await afterRestart();
    expect(c.s().doc.edges).toEqual(a.s().doc.edges);
    expect(cableTable(c.s().doc)).toEqual(cableTable(a.s().doc));
  });

  it("undoes this editor's own wiring one operation at a time, keeping the other editor's lines, through a killed server", async () => {
    const a = await editor();
    const b = await editor();
    const r = await rack(a, b);
    const mine = connect(a, portOf(a, r.pc1, 'HDMI 1'), r.conv);
    const theirs = connect(b, portOf(b, r.pc2, 'HDMI 1'), r.pj);
    for (const x of [a, b]) await until(() => !!line(x, mine) && !!line(x, theirs), 5_000, 'both lines on each editor');

    a.s().undo();
    expect(lineIds(a)).toEqual([theirs]);
    a.s().redo();
    expect(lineIds(a).sort()).toEqual([mine, theirs].sort());
    // A device goes with its lines, and comes back with them.
    const was = line(a, mine);
    a.s().removeIds([r.pc1]);
    expect(lineIds(a)).toEqual([theirs]);
    a.s().undo();
    expect(line(a, mine)).toEqual(was);
    await until(() => !!b.node(r.pc1) && !!line(b, mine), 5_000, 'the undo to reach the other editor');
    expect(line(b, theirs)).toBeDefined();
    await a.stored();

    const c = await afterRestart();
    expect(c.s().doc.edges).toEqual(a.s().doc.edges);
  });
});
