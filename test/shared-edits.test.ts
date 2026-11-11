import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { allIds, freshId } from '../src/model/ids';
import { JUNCTION, makeDevice, makeLegend, makeNode, presetOf } from '../src/model/presets';
import type { DeviceNode, Doc, Node } from '../src/model/types';
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
