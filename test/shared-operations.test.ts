import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { allIds } from '../src/model/ids';
import { makeDevice, makeEdge, makeImage, makeNode, presetOf } from '../src/model/presets';
import type { DeviceNode, Doc, Node } from '../src/model/types';
import { type RunningServer, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
const sessions: Session[] = [];

beforeEach(async () => {
  stubPage({ realTimers: true });
  ({ data, seed, token } = seedData('system'));
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/**
 * An editor with a board of its own holding `mine` (in a project named as the shared one), showing
 * the shared project's system board; `first` is done on its own board before the project is opened.
 */
async function editor(mine: Node[] = [], first: (session: Session) => void = () => {}) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession();
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: seed.title }, nodes: mine }]);
  await session.boot(disk.backend);
  first(session);
  await session.openCollab({ server: server.url, project: seed.id, token });
  const s = () => session.useStore.getState();
  const node = (id: string) => s().doc.nodes.find((n) => n.id === id);
  /** Put a node on the board as the toolbar does, in one step. */
  const add = <T extends Node>(make: (taken: Set<string>) => T): T => {
    let made: T | undefined;
    s().mutate((d) => {
      made = make(allIds(d));
      return { ...d, nodes: [...d.nodes, made] };
    });
    return made!;
  };
  /** Move nodes as the canvas does while dragging them: an operation begun, the steps shown, ended on letting go (unless `held`). */
  const move = (ids: string[], dx: number, held = false) => {
    const by = new Set(ids);
    s().checkpoint();
    for (const step of [dx / 2, dx / 2]) s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (by.has(n.id) ? { ...n, x: n.x + step } : n)) }), false);
    if (!held) s().commitOperation();
  };
  /** Colour nodes together as the quick bar does, in one step. */
  const recolor = (ids: string[], color: string) => {
    const by = new Set(ids);
    s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (by.has(n.id) ? ({ ...n, color } as Node) : n)) }));
  };
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { session, s, node, add, move, recolor, stored };
}

/** Kill the server outright, start it again over the same data, and open the project in a new editor. */
async function afterRestart() {
  await server.kill();
  server = await startServer(data);
  return editor();
}

const ids = (doc: Doc) => doc.nodes.map((n) => n.id);
const colorOf = (n: Node | undefined) => (n as { color?: string } | undefined)?.color;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('operations of several steps on a shared board', () => {
  it('makes copies under ids of their own, the line between them joining the copies, while the other editor adds at once; one undo takes them back; through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const pc = a.add((t) => makeDevice(presetOf('pc')!, 300, 0, t));
    const pj = a.add((t) => makeDevice(presetOf('pj')!, 600, 0, t));
    // A line between the two devices copied, and one to the shape, which is not.
    let line = '';
    a.s().mutate((d) => {
      const made = makeEdge(allIds(d), { node: pc.id, port: pc.ports[0].id }, { node: pj.id, port: pj.ports[0].id }, pc.ports[0].signal);
      const out = makeEdge(new Set([made.id]), { node: seed.shape.id }, { node: pc.id }, 'flow');
      line = made.id;
      return { ...d, edges: [...d.edges, made, out] };
    });
    const lines = a.s().doc.edges.map((e) => e.id);
    await until(() => b.s().doc.edges.length === 2, 5_000, 'the lines to reach the other editor');

    // At once: one duplicates the two devices and their line, the other pastes a copy of the shape and puts a node there.
    a.s().select([pc.id, pj.id, line]);
    a.session.duplicateSelection();
    const copies = a.s().selection;
    b.s().select([seed.shape.id]);
    expect(b.session.copySelection()).toBe(true);
    b.session.pasteClipboard();
    const pasted = b.s().selection;
    const put = b.add((t) => makeNode('ellipse', 0, 300, t));

    for (const x of [a, b]) await until(() => x.s().doc.nodes.length === 7 && x.s().doc.edges.length === 3, 5_000, 'every copy and node on each editor');
    expect(ids(b.s().doc)).toEqual(ids(a.s().doc));
    expect(new Set(ids(a.s().doc)).size).toBe(7);
    expect(copies).toEqual([expect.stringMatching(new RegExp(`^pc-${UUID}$`)), expect.stringMatching(new RegExp(`^pj-${UUID}$`))]);
    expect(pasted).toEqual([expect.stringMatching(new RegExp(`^n-${UUID}$`))]);
    const copied = b.s().doc.edges.find((e) => !lines.includes(e.id))!;
    expect(copied.id).toMatch(new RegExp(`^e-${UUID}$`));
    expect(copied.from).toEqual({ node: copies[0], port: pc.ports[0].id });
    expect(copied.to).toEqual({ node: copies[1], port: pj.ports[0].id });

    a.s().undo();
    for (const id of copies) expect(a.node(id)).toBeUndefined();
    expect(a.s().doc.edges.map((e) => e.id)).toEqual(lines);
    expect(a.node(pasted[0])).toBeDefined();
    expect(a.node(put.id)).toBeDefined();
    await until(() => b.s().doc.nodes.length === 5, 5_000, 'the undo to reach the other editor');
    a.s().redo();
    await until(() => b.s().doc.nodes.length === 7 && b.s().doc.edges.length === 3, 5_000, 'the redo to reach the other editor');
    await a.stored();
    await b.stored();

    const c = await afterRestart();
    expect(c.s().doc.nodes).toEqual(b.s().doc.nodes);
    expect(c.s().doc.edges).toEqual(b.s().doc.edges);
  });

  it('pastes a device copied from a board of this machine without its links to other boards, which a shared board does not hold yet', async () => {
    const linked: DeviceNode = { ...makeDevice(presetOf('pc')!, 0, 0, new Set()), shared: 'pc-key', sharedAt: 1, runsOn: 'host-key' };
    const a = await editor([linked], (session) => {
      session.useStore.getState().select([linked.id]);
      expect(session.copySelection()).toBe(true);
    });
    const b = await editor();
    a.session.pasteClipboard();
    const [copy] = a.s().selection;
    await until(() => !!b.node(copy), 5_000, 'the copy to reach the other editor');
    expect(copy).toMatch(new RegExp(`^pc-${UUID}$`));
    for (const x of [a, b]) expect(x.node(copy)).toEqual({ ...linked, id: copy, x: 30, y: 30, shared: undefined, sharedAt: undefined, runsOn: undefined });
  });

  it('turns away a paste of what a shared board does not hold yet, leaving the selection as it was', async () => {
    const picture = makeImage(new Set(), { src: 'data:,', w: 40, h: 40, name: '会場図' }, 0, 0);
    const a = await editor([picture], (session) => {
      session.useStore.getState().select([picture.id]);
      expect(session.copySelection()).toBe(true);
    });
    a.s().select([seed.shape.id]);
    a.session.pasteClipboard();
    expect(a.s().notice).toMatch(/共有中のボードでは/);
    expect(ids(a.s().doc)).toEqual([seed.shape.id]);
    expect(a.s().selection).toEqual([seed.shape.id]);
  });

  it('aligns, moves and recolours several nodes as one step each, keeping what the other editor changed of them meanwhile', async () => {
    const a = await editor();
    const b = await editor();
    const one = a.add((t) => makeNode('rect', 270, 70, t));
    const two = a.add((t) => makeNode('rect', 470, 130, t));
    await until(() => !!b.node(two.id), 5_000, 'the nodes to reach the other editor');
    const both = [one.id, two.id];

    // At once: one aligns their tops, the other colours both.
    a.s().select(both);
    a.session.align('top');
    b.recolor(both, 'blue');
    // At once: one drags both, the other changes the size of one.
    a.move(both, 100);
    b.s().updateNode(two.id, { w: 200, h: 90 });

    for (const x of [a, b]) {
      await until(() => colorOf(x.node(two.id)) === 'blue' && x.node(two.id)?.w === 200 && x.node(two.id)?.x === 500, 5_000, 'both editors to have every change');
      expect(x.node(one.id)).toMatchObject({ x: 300, y: 40, color: 'blue' });
      expect(x.node(two.id)).toMatchObject({ x: 500, y: 40, w: 200, h: 90, color: 'blue' });
    }

    a.s().undo();
    expect(a.node(one.id)).toMatchObject({ x: 200, y: 40, color: 'blue' });
    expect(a.node(two.id)).toMatchObject({ x: 400, y: 40, w: 200 });
    a.s().undo();
    expect(a.node(two.id)).toMatchObject({ x: 400, y: 100, w: 200, color: 'blue' });
    await until(() => b.node(two.id)?.y === 100, 5_000, 'the undos to reach the other editor');
    b.s().undo();
    expect(b.node(two.id)).toMatchObject({ x: 400, y: 100, w: 140, color: 'blue' });
    b.s().undo();
    expect([colorOf(b.node(one.id)), colorOf(b.node(two.id))]).toEqual(['white', 'white']);
    expect(b.node(one.id)).toMatchObject({ x: 200, y: 40 });
  });

  it('goes on moving what is left when the other editor takes one of the nodes off, never bringing it back, and Escape calls off only its own move', async () => {
    const a = await editor();
    const b = await editor();
    const one = a.add((t) => makeNode('rect', 270, 70, t));
    const two = a.add((t) => makeNode('rect', 470, 70, t));
    await until(() => !!b.node(two.id), 5_000, 'the nodes to reach the other editor');

    a.s().select([one.id, two.id]);
    a.move([one.id, two.id], 50, true);
    b.s().removeIds([two.id]);
    await until(() => !a.node(two.id), 5_000, 'the node to go from the editor moving it');
    a.s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === one.id || n.id === two.id ? { ...n, x: n.x + 50 } : n)) }), false);
    a.s().commitOperation();
    for (const x of [a, b]) await until(() => x.node(one.id)?.x === 300, 5_000, 'the move to end on each editor');
    expect(a.node(two.id)).toBeUndefined();
    expect(b.node(two.id)).toBeUndefined();

    // Called off while the other editor recolours the node being moved: the colour stays, the move goes.
    a.move([one.id], 300, true);
    b.recolor([one.id], 'green');
    await until(() => colorOf(a.node(one.id)) === 'green', 5_000, 'the colour to reach the editor moving it');
    a.s().dropStep();
    expect(a.node(one.id)).toMatchObject({ x: 300, color: 'green' });
    a.s().undo();
    expect(a.node(one.id)).toMatchObject({ x: 200, color: 'green' });
    await a.stored();
    await b.stored();

    const c = await afterRestart();
    expect(ids(c.s().doc)).toEqual([seed.shape.id, one.id]);
    expect(c.node(one.id)).toMatchObject({ x: 200, color: 'green' });
  });

  it("undoes the board on screen's own operations after switching boards, each board keeping its own", async () => {
    const a = await editor();
    const b = await editor();
    a.s().collab!.manage.add('照明', 'free');
    const light = a.s().doc.id;
    const lamp = a.add((t) => makeNode('ellipse', 0, 200, t));
    a.s().openBoard(seed.board.id);
    a.move([seed.shape.id], 120);
    const theirs = b.add((t) => makeNode('diamond', 300, 300, t));

    a.s().openBoard(light);
    expect(a.s().collab?.undo).toBe(true);
    a.s().undo();
    expect(a.node(lamp.id)).toBeUndefined();
    expect(a.s().collab?.undo).toBe(false);
    a.s().openBoard(seed.board.id);
    await until(() => !!a.node(theirs.id), 5_000, "the other editor's node to arrive");
    expect(a.node(seed.shape.id)?.x).toBe(120);
    a.s().undo();
    expect(a.node(seed.shape.id)?.x).toBe(0);
    expect(a.node(theirs.id)).toBeDefined();
    a.s().openBoard(light);
    a.s().redo();
    expect(a.node(lamp.id)).toBeDefined();
  });
});
