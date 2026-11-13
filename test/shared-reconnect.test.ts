import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { type SharedProject, joinProject } from '../src/collab/client';
import { type ProjectSeed, SCHEMA, boardDoc } from '../src/collab/model';
import type { DeviceStore } from '../src/collab/kept';
import { allIds } from '../src/model/ids';
import { makeNode } from '../src/model/presets';
import type { Node } from '../src/model/types';
import { type RunningServer, administer, memoryDevice, seedData, startRelay, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
/** The editor's invite of seedData. */
let token: string;
let server: RunningServer;
const sessions: Session[] = [];
const joined: SharedProject[] = [];

beforeEach(async () => {
  stubPage({ realTimers: true });
  ({ data, seed, token } = seedData());
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  joined.splice(0).forEach((p) => p.close());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Someone on a page of their own showing the shared project, keeping its copy in `device` (a page opened again on the same device is handed the same one). */
async function editor(options: { device?: DeviceStore; url?: string; token?: string } = {}) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession({ device: options.device ?? null });
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: options.url ?? server.url, project: seed.id, token: options.token ?? token });
  const s = () => session.useStore.getState();
  const node = (id: string) => s().doc.nodes.find((n) => n.id === id);
  /** Drag a node as the canvas does: an operation begun, moves shown as it goes, committed on letting go. */
  const drag = (id: string, x: number, y: number) => {
    s().checkpoint();
    s().updateNode(id, { x: x / 2, y: y / 2 }, false);
    s().updateNode(id, { x, y }, false);
    s().commitOperation();
  };
  const stored = (ms = 5_000) => until(() => s().saving === 'saved' && s().collab?.pending === 0, ms, 'the edits to be stored');
  const offline = () => until(() => s().collab?.link === 'offline', 5_000, 'the server to be missed');
  const kept = () => until(() => s().collab?.device === 'saved', 5_000, 'the edits to be kept on this device');
  const refused = () => until(() => s().collab?.link === 'refused', 10_000, 'the server to turn this device away');
  return { session, disk, s, node, drag, stored, offline, kept, refused };
}

/** A client of the shared project without a page, once the server has sent it. */
async function client(): Promise<SharedProject> {
  const project = joinProject({ server: server.url, project: seed.id, token });
  joined.push(project);
  await project.ready;
  return project;
}

const at = (n: Pick<Node, 'x' | 'y'> | undefined) => n && { x: n.x, y: n.y };

/** What the server has stored of the project: how many edits it has taken, and where the shape is. */
function onServer() {
  const db = new DatabaseSync(join(data, 'keito-collab.sqlite'), { readOnly: true });
  try {
    const ops = Number(db.prepare('SELECT count(*) AS n FROM ops WHERE project = ?').get(seed.id)?.n);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, administer(data, (store) => store.load(seed.id))!);
    return { ops, shape: at(boardDoc(ydoc, seed.board.id)?.nodes.find((n) => n.id === seed.shape.id)) };
  } finally {
    db.close();
  }
}

/** Make the project's form one this version of the app does not read, as a server of a later version would have it. */
function laterSchema(): void {
  const db = new DatabaseSync(join(data, 'keito-collab.sqlite'));
  try {
    db.prepare('UPDATE projects SET schema = ? WHERE id = ?').run(SCHEMA + 1, seed.id);
  } finally {
    db.close();
  }
}

/** What the server does that turns this device's edits away, the credential the device comes back with, and the reason it is told. */
const turnedAway: [string, () => string, string][] = [
  ['the invite revoked', () => (administer(data, (store) => store.revokeGrant(store.grantOf(token)!)), token), 'revoked'],
  ['a viewer invite', () => administer(data, (store) => store.addGrant(seed.id, 'viewer')).token, 'read-only'],
  ['the project of a later schema', () => (laterSchema(), token), 'schema'],
  ['the project deleted', () => (administer(data, (store) => store.deleteProject(seed.id)), token), 'deleted'],
];

/** An editor who moved the shape to (300, 40) while the server was down, then closed the page: the move kept on `device` only. */
async function movedOffline(device: ReturnType<typeof memoryDevice>): Promise<void> {
  const a = await editor({ device: device.store });
  await server.kill();
  await a.offline();
  a.drag(seed.shape.id, 300, 40);
  await until(() => a.s().collab?.device === 'saved' && a.s().collab?.pending === 1, 5_000, 'the move to be kept on this device');
  a.session.dispose();
}

// A server killed and started again, and a page turned away, take longer than the default 5 s.
describe('edits kept on this device that the server turns away on reconnecting', { timeout: 30_000 }, () => {
  it.each(turnedAway)('are not stored (%s): the project stays on screen with them, saying why, and takes no edit', async (_, turnAway, refusal) => {
    const device = memoryDevice();
    const { port } = server;
    await movedOffline(device);
    const before = onServer();
    const credential = turnAway();
    server = await startServer(data, port);

    const b = await editor({ device: device.store, token: credential });
    await b.refused();
    expect(b.s().collab).toMatchObject({ refusal, pending: 1 });
    expect(b.s().collab?.recover).toBeTruthy();
    expect(at(b.node(seed.shape.id))).toEqual({ x: 300, y: 40 });
    b.drag(seed.shape.id, 10, 10);
    expect(at(b.node(seed.shape.id))).toEqual({ x: 300, y: 40 });
    expect(onServer()).toEqual(before);
  });

  it('are shown while the page stays open, when the invite was revoked while it was offline', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    const { port } = server;
    await server.kill();
    await a.offline();
    a.drag(seed.shape.id, 300, 40);
    await a.kept();
    const before = onServer();
    administer(data, (store) => store.revokeGrant(store.grantOf(token)!));
    server = await startServer(data, port);
    await a.refused();
    expect(a.s().collab).toMatchObject({ refusal: 'revoked', pending: 1 });
    expect(at(a.node(seed.shape.id))).toEqual({ x: 300, y: 40 });
    expect(onServer()).toEqual(before);
  });

  it('open again after a restart as they were, without asking the server again, and become boards of this machine', async () => {
    const device = memoryDevice();
    const { port } = server;
    await movedOffline(device);
    administer(data, (store) => store.revokeGrant(store.grantOf(token)!));
    const output: string[] = [];
    server = await startServer(data, port, output);
    const asked = () => output.filter((line) => line.includes('connection refused')).length;
    const b = await editor({ device: device.store });
    await b.refused();
    // Given time to try again, it does not.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(asked()).toBe(1);
    b.session.dispose();

    const c = await editor({ device: device.store });
    expect(c.s().collab).toMatchObject({ link: 'refused', refusal: 'revoked', pending: 1 });
    expect(at(c.node(seed.shape.id))).toEqual({ x: 300, y: 40 });
    await c.s().collab!.recover!.copy();
    await until(() => c.s().collab === null, 5_000, 'the copy to be opened');
    expect(c.s().doc.meta.project).toBe('共有テスト のコピー');
    expect(at(c.node(seed.shape.id))).toEqual({ x: 300, y: 40 });
    const local = [...c.disk.box.kept.values()].map(({ doc }) => doc).find((d) => d.meta.project === '共有テスト のコピー');
    expect(at(local?.nodes.find((n) => n.id === seed.shape.id))).toEqual({ x: 300, y: 40 });
    expect(asked()).toBe(1);
    // Taken out, they are no longer kept as the project's.
    expect(device.kept.size).toBe(0);
  });

  it('are not let go by taking out a project left with no board', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    const { port } = server;
    await server.kill();
    await a.offline();
    a.s().deleteBoard(seed.board.id);
    await until(() => a.s().collab?.device === 'saved' && a.s().collab?.pending === 1, 5_000, 'the delete to be kept on this device');
    a.session.dispose();
    administer(data, (store) => store.revokeGrant(store.grantOf(token)!));
    server = await startServer(data, port);

    const b = await editor({ device: device.store });
    await b.refused();
    expect(b.s().collab?.pending).toBe(1);
    await b.s().collab!.recover!.copy();
    expect(b.s().notice).toMatch(/コピーするボードがありません/);
    expect(b.s().collab?.link).toBe('refused');
    expect(device.kept.size).toBe(1);
  });

  it('are not sent once the project is restored, and are let go only when asked, the project opening anew from the server', async () => {
    const device = memoryDevice();
    const { port } = server;
    await movedOffline(device);
    administer(data, (store) => store.deleteProject(seed.id));
    server = await startServer(data, port);
    const b = await editor({ device: device.store });
    await b.refused();
    b.session.dispose();
    administer(data, (store) => store.restoreProject(seed.id));
    const before = onServer();

    const c = await editor({ device: device.store });
    expect(c.s().collab).toMatchObject({ link: 'refused', refusal: 'deleted', pending: 1 });
    c.s().collab!.recover!.rejoin();
    await until(() => c.s().collab?.link === 'online', 10_000, 'the project to be opened from the server');
    expect(c.s().collab?.pending).toBe(0);
    expect(at(c.node(seed.shape.id))).toEqual({ x: 0, y: 0 });
    expect(onServer()).toEqual(before);

    // Kept on this device again: it opens while the server is down.
    await c.kept();
    c.session.dispose();
    const down = server.url;
    await server.kill();
    const d = await editor({ device: device.store, url: down });
    expect(d.s().collab?.project).toBe(seed.id);
  });
});

describe('a device the server turns away with nothing of its own unsent', { timeout: 30_000 }, () => {
  it('leaves the project, and keeps a copy of it again once let in', async () => {
    const device = memoryDevice();
    const told = vi.spyOn(window, 'alert');
    const a = await editor({ device: device.store });
    administer(data, (store) => store.deleteProject(seed.id));
    await until(() => a.s().collab === null, 5_000, 'the delete to be heard');
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/この共有案件は削除されています/));
    a.session.dispose();

    administer(data, (store) => store.restoreProject(seed.id));
    const b = await editor({ device: device.store });
    expect(b.s().collab?.link).toBe('online');
    await b.kept();
    b.session.dispose();
    const down = server.url;
    await server.kill();
    const c = await editor({ device: device.store, url: down });
    expect(c.s().collab?.project).toBe(seed.id);
  });
});

describe('an edit made offline on a board deleted meanwhile', { timeout: 30_000 }, () => {
  it('stays inside that board, which stays deleted for everyone, while the edits on the other boards are stored', async () => {
    const relay = await startRelay(server.url);
    try {
      const a = await editor({ device: memoryDevice().store, url: relay.url });
      const other = await client();
      const second = other.addBoard('配線', 'free')!;
      await until(() => a.s().collab?.boards.length === 2, 5_000, 'the second board to reach the editor');
      a.s().openBoard(second);
      let put: Node | undefined;
      a.s().mutate((d) => {
        put = makeNode('rect', 0, 0, allIds(d), '配線の図形');
        return { ...d, nodes: [...d.nodes, put] };
      });
      await a.stored();

      relay.cut();
      await a.offline();
      a.drag(put!.id, 500, 500);
      a.s().openBoard(seed.board.id);
      a.drag(seed.shape.id, 300, 40);
      other.removeBoard(second);
      await until(() => !other.status().pending, 5_000, 'the delete to be stored');

      relay.reopen();
      await a.stored(15_000);
      expect(a.s().collab?.boards.map((b) => b.id)).toEqual([seed.board.id]);

      await server.kill();
      server = await startServer(data);
      const c = await client();
      expect(c.boards().map((b) => b.id)).toEqual([seed.board.id]);
      expect(at(c.board(seed.board.id)?.nodes.find((n) => n.id === seed.shape.id))).toEqual({ x: 300, y: 40 });
      // Restored, by hand, the board holds what was done on it offline.
      c.restoreBoard(second);
      expect(at(c.board(second)?.nodes.find((n) => n.id === put!.id))).toEqual({ x: 500, y: 500 });
    } finally {
      await relay.close();
    }
  });
});
