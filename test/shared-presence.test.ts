import { rmSync } from 'node:fs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ProjectSeed } from '../src/collab/model';
import { SCHEMA } from '../src/collab/model';
import { COLORS, type Peer } from '../src/collab/presence';
import { writeCredential } from '../src/collab/protocol';
import type { State } from '../src/model/store';
import { administer, type RunningServer, seedData, startRelay, startServer, storedEdits, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
const sessions: Session[] = [];
const providers: HocuspocusProvider[] = [];

beforeEach(async () => {
  stubPage({ realTimers: true });
  ({ data, seed, token } = seedData());
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  providers.splice(0).forEach((p) => p.destroy());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Someone on a page of their own, showing the shared project (by way of `url`, the server's unless given). */
async function person(options: { url?: string; project?: string; credential?: string } = {}) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession({ device: null });
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: options.url ?? server.url, project: options.project ?? seed.id, token: options.credential ?? token });
  const s = () => session.useStore.getState();
  const shape = () => s().doc.nodes.find((n) => n.id === seed.shape.id);
  /** Hold the shape dragged to (x, y), as the canvas does before the pointer is let go: an operation begun, its moves shown. */
  const hold = (x: number, y: number) => {
    s().checkpoint();
    s().updateNode(seed.shape.id, { x: x / 2, y: y / 2 }, false);
    s().updateNode(seed.shape.id, { x, y }, false);
  };
  /** The one other page this page shows, named `name`. */
  const peer = (name: string): Peer | undefined => s().peers.find((p) => p.name === name);
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { session, s, shape, hold, peer, stored };
}

/** What of a page is its own: what it looks at and how, and what it has picked. */
const personal = (s: State) => ({ view: s.view, tool: s.tool, panel: s.panel, docks: s.docks, board: s.doc.id, selection: s.selection });

/** How many edits the server has stored of the project. */

/** A client of the server that only listens, as a page changed by its user could: what it hears of the others' presence is all that was sent. */
async function listener() {
  const provider = new HocuspocusProvider({ url: server.url, name: seed.id, document: new Y.Doc(), token: writeCredential({ token, schema: SCHEMA }) });
  providers.push(provider);
  await new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  return provider;
}

const SHAPE = { w: 160, h: 80 };

describe('presence in a shared project', () => {
  it("tells the others who is there, on which board, where the pointer is and what is selected, without changing anything of the others' own", async () => {
    const a = await person();
    const b = await person();
    const mine = personal(b.s());
    a.s().collab!.introduce({ name: 'あかね', color: COLORS[2] });
    a.s().collab!.point({ x: 12, y: 34 });
    a.s().select([seed.shape.id]);
    await until(() => !!b.peer('あかね')?.selection.length, 5_000, "a's selection to reach b");
    expect(b.peer('あかね')).toMatchObject({ color: COLORS[2], board: seed.board.id, pointer: { x: 12, y: 34 }, selection: [seed.shape.id], editing: [], moving: [] });
    expect(a.s().peers).toHaveLength(1);

    // Another board on screen there: the others hear which, and stay where they are.
    a.s().collab!.manage.add('二枚目', 'free');
    const second = a.s().doc.id;
    expect(second).not.toBe(seed.board.id);
    await until(() => b.peer('あかね')?.board === second, 5_000, "a's board to reach b");
    expect(b.peer('あかね')).toMatchObject({ pointer: null, selection: [] });
    expect(personal(b.s())).toEqual(mine);
  });

  it('shows a drag to the others as it goes, and writes it to the project once, where it is let go', async () => {
    const a = await person();
    const b = await person();
    a.s().collab!.introduce({ name: 'あかね', color: COLORS[0] });
    const before = storedEdits(data, seed.id);
    a.hold(240, 120);
    await until(() => !!b.peer('あかね')?.moving.length, 5_000, 'the drag to be shown to b');
    expect(b.peer('あかね')).toMatchObject({ editing: [seed.shape.id], moving: [{ id: seed.shape.id, x: 240, y: 120, ...SHAPE }] });
    expect(b.shape()).toMatchObject({ x: 0, y: 0 });
    expect(storedEdits(data, seed.id)).toBe(before);

    a.s().commitOperation();
    await a.stored();
    await until(() => b.shape()?.x === 240 && !b.peer('あかね')?.moving.length, 5_000, 'the drag to be written');
    expect(b.peer('あかね')?.editing).toEqual([]);
    expect(storedEdits(data, seed.id)).toBe(before + 1);
  });

  it('leaves the place last written when a drag is called off, or the page dragging loses its connection', async () => {
    const relay = await startRelay(server.url);
    try {
      const a = await person({ url: relay.url });
      const b = await person();
      a.s().collab!.introduce({ name: 'あかね', color: COLORS[0] });
      const before = storedEdits(data, seed.id);

      a.hold(240, 120);
      await until(() => !!b.peer('あかね')?.moving.length, 5_000, 'the drag to be shown to b');
      // Escape.
      a.s().dropStep();
      await until(() => b.peer('あかね')?.moving.length === 0 && b.peer('あかね')?.editing.length === 0, 5_000, 'the drag called off to leave b');
      expect(b.shape()).toMatchObject({ x: 0, y: 0 });

      a.hold(300, 200);
      await until(() => !!b.peer('あかね')?.moving.length, 5_000, 'the drag to be shown to b');
      relay.cut();
      await until(() => !b.peer('あかね'), 5_000, 'the page cut off to leave b');
      expect(b.shape()).toMatchObject({ x: 0, y: 0 });
      expect(storedEdits(data, seed.id)).toBe(before);
      await until(() => a.s().collab?.link === 'offline' && a.s().peers.length === 0, 5_000, 'b to leave the page cut off');
    } finally {
      await relay.close();
    }
  });

  it('holds no one off a node another is dragging: both drags are written, and both pages end with the same place', async () => {
    const a = await person();
    const b = await person();
    a.s().collab!.introduce({ name: 'あかね', color: COLORS[0] });
    b.s().collab!.introduce({ name: 'ひかり', color: COLORS[1] });
    a.hold(240, 0);
    b.hold(0, 120);
    await until(() => !!a.peer('ひかり')?.moving.length && !!b.peer('あかね')?.moving.length, 5_000, 'each drag to be shown to the other');
    a.s().commitOperation();
    b.s().commitOperation();
    await Promise.all([a.stored(), b.stored()]);
    await until(() => JSON.stringify(a.shape()) === JSON.stringify(b.shape()), 5_000, 'the pages to agree');
    expect([{ x: 240, y: 0 }, { x: 0, y: 120 }]).toContainEqual({ x: a.shape()!.x, y: a.shape()!.y });
  });

  it('stops showing a page once it leaves, loses its connection, or opens another project', async () => {
    const relay = await startRelay(server.url);
    try {
      const a = await person();
      const b = await person({ url: relay.url });
      const c = await person();
      for (const [who, name] of [[a, 'あかね'], [b, 'ひかり'], [c, 'みどり']] as const) who.s().collab!.introduce({ name, color: COLORS[0] });
      await until(() => a.s().peers.length === 2 && !!a.peer('ひかり') && !!a.peer('みどり'), 5_000, 'everyone to be shown');

      // Gone with its connection, back with it, and gone again with the new one.
      relay.cut();
      await until(() => !a.peer('ひかり'), 5_000, 'the page cut off to leave a');
      await until(() => b.s().peers.length === 0, 5_000, 'the others to leave the page cut off');
      relay.reopen();
      await until(() => !!a.peer('ひかり') && !!b.peer('あかね'), 15_000, 'the page to be shown again once back');
      relay.cut();
      await until(() => !a.peer('ひかり'), 5_000, 'the page cut off again to leave a');
      relay.reopen();
      await until(() => !!a.peer('ひかり'), 15_000, 'the page to be shown again once back');

      // Another project opened there.
      const other = administer(data, (store) => {
        const project = store.initProject({ title: '別の案件', board: '別の配置', shape: '図形' });
        return { project: project.id, token: store.addGrant(project.id).token };
      });
      await c.session.openCollab({ server: server.url, project: other.project, token: other.token });
      expect(c.s().collab?.project).toBe(other.project);
      await until(() => !a.peer('みどり'), 5_000, 'the page gone to another project to leave a');
      expect(c.s().peers).toEqual([]);

      // Closed.
      b.session.dispose();
      await until(() => a.s().peers.length === 0, 5_000, 'the closed page to leave a');
    } finally {
      await relay.close();
    }
  });

  it('drops the marks of a node someone else takes off the board', async () => {
    const a = await person();
    const b = await person();
    a.s().collab!.introduce({ name: 'あかね', color: COLORS[0] });
    a.s().select([seed.shape.id]);
    a.hold(240, 120);
    await until(() => !!b.peer('あかね')?.moving.length && !!b.peer('あかね')?.selection.length, 5_000, 'the drag to be shown to b');
    b.s().removeIds([seed.shape.id]);
    await b.stored();
    await until(() => !a.shape(), 5_000, 'the shape to leave a');
    await until(() => {
      const p = b.peer('あかね');
      return !!p && !p.selection.length && !p.editing.length && !p.moving.length;
    }, 5_000, "the marks of the shape to leave a's presence");
  });

  it('keeps presence out of the project as stored, the board on screen and the server output, and sends no secret in it', async () => {
    await server.kill();
    const output: string[] = [];
    server = await startServer(data, 0, output);
    const watching = await listener();
    const a = await person();
    const invite = administer(data, (store) => store.grantOf(token));
    const name = 'presence-only-name';
    a.s().collab!.introduce({ name, color: COLORS[3] });
    a.s().collab!.point({ x: 5, y: 6 });
    a.s().select([seed.shape.id]);
    a.hold(240, 120);
    await until(() => [...watching.awareness!.getStates().values()].some((p) => p.name === name && p.moving?.length), 5_000, 'the listener to hear a');
    const heard = [...watching.awareness!.getStates().entries()].filter(([id]) => id !== watching.awareness!.clientID).map(([, state]) => state);
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0]).sort()).toEqual(['board', 'color', 'editing', 'moving', 'name', 'pointer', 'selection']);
    for (const secret of [token, invite!]) expect(JSON.stringify(heard).includes(secret)).toBe(false);

    a.s().commitOperation();
    await a.stored();
    await server.kill();
    const stored = administer(data, (store) => store.load(seed.id))!;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, stored);
    for (const text of [JSON.stringify(ydoc.toJSON()), JSON.stringify(a.s().doc), output.join('\n')]) {
      expect(text.includes(name)).toBe(false);
      expect(text.includes('pointer')).toBe(false);
    }
  });

  it("shows nothing of what another page sends that is not presence as this app sends it", async () => {
    const watching = await listener();
    const a = await person();
    watching.awareness!.setLocalState({ name: 'x'.repeat(10_000), color: 'red; display:none', board: seed.board.id, pointer: { x: 'far' }, selection: 'all', editing: [], moving: [] });
    const b = await person();
    b.s().collab!.introduce({ name: 'ひかり', color: COLORS[1] });
    await until(() => !!a.peer('ひかり'), 5_000, 'b to be shown to a');
    expect(a.s().peers).toHaveLength(1);
  });
});
