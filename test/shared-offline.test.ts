import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CollabStore, openStore } from '../server/collab/store';
import type { DeviceStore } from '../src/collab/kept';
import type { ProjectSeed } from '../src/collab/model';
import { allIds } from '../src/model/ids';
import { makeNode } from '../src/model/presets';
import type { Doc, Node } from '../src/model/types';
import { type RunningServer, memoryDevice, seedData, startRelay, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let page: ReturnType<typeof stubPage>;
let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
const sessions: Session[] = [];

beforeEach(async () => {
  page = stubPage({ realTimers: true });
  ({ data, seed, token } = seedData());
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/**
 * An editor showing the shared project, keeping its copy in `device` (a page opened again on the
 * same device is handed the same one); `page`: the one that hears the page close.
 */
async function editor(options: { device?: DeviceStore; url?: string; page?: boolean } = {}) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession({ page: options.page, device: options.device ?? null });
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: options.url ?? server.url, project: seed.id, token });
  const s = () => session.useStore.getState();
  const node = (id: string) => s().doc.nodes.find((n) => n.id === id);
  /** Drag a node as the canvas does: an operation begun, moves shown as it goes, committed on letting go. */
  const drag = (id: string, x: number, y: number) => {
    s().checkpoint();
    s().updateNode(id, { x: x / 2, y: y / 2 }, false);
    s().updateNode(id, { x, y }, false);
    s().commitOperation();
  };
  /** Put a shape on the board as the toolbar does. */
  const add = (text: string, y: number): Node => {
    let made: Node | undefined;
    s().mutate((d) => {
      made = makeNode('rect', 0, y, allIds(d), text);
      return { ...d, nodes: [...d.nodes, made] };
    });
    return made!;
  };
  const stored = (ms = 5_000) => until(() => s().saving === 'saved' && s().collab?.pending === 0, ms, 'the edits to be stored');
  const offline = () => until(() => s().collab?.link === 'offline', 5_000, 'the server to be missed');
  return { session, s, node, drag, add, stored, offline };
}

const at = (n: Node | undefined) => n && { x: n.x, y: n.y };
/** The nodes of a board, in an order that does not depend on who put them there first. */
const nodesOf = (doc: Doc) => [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id));

/** Change the server's SQLite file as the administration commands do. */
function administer(change: (store: CollabStore) => void): void {
  const store = openStore(join(data, 'keito-collab.sqlite'));
  try {
    change(store);
  } finally {
    store.close();
  }
}

/** Whether the page would ask before it closes. */
function asksOnClose(): boolean {
  const close = { preventDefault: vi.fn(), returnValue: undefined as unknown };
  page.listeners.beforeunload?.(close);
  return close.preventDefault.mock.calls.length > 0;
}

describe('a shared project kept on this device', () => {
  it('opens while the server is down with the edit it had not sent, once only, and sends the edit when the server is back', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    a.drag(seed.shape.id, 240, 120);
    await a.stored();
    const { port } = server;
    await server.kill();
    await a.offline();
    a.drag(seed.shape.id, 300, 40);
    await until(() => a.s().collab?.device === 'saved' && a.s().collab?.pending === 1, 5_000, 'the edit to be kept on this device');
    // The page reloaded: what it held in memory is gone.
    a.session.dispose();

    const b = await editor({ device: device.store });
    expect(b.s().collab?.project).toBe(seed.id);
    expect(b.s().collab?.link).not.toBe('online');
    expect(b.s().doc.nodes.map((n) => [n.id, n.x, n.y])).toEqual([[seed.shape.id, 300, 40]]);
    expect(b.s().collab?.pending).toBe(1);

    server = await startServer(data, port);
    await b.stored(15_000);
    const c = await editor();
    expect(c.s().doc.nodes.map((n) => [n.id, n.x, n.y])).toEqual([[seed.shape.id, 300, 40]]);
  });

  it('is not opened from a link to another server, nor are its unsent edits sent there', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    a.drag(seed.shape.id, 240, 120);
    await a.stored();
    await server.kill();
    await a.offline();
    a.drag(seed.shape.id, 300, 40);
    await until(() => a.s().collab?.device === 'saved' && a.s().collab?.pending === 1, 5_000, 'the edit to be kept on this device');
    a.session.dispose();
    // Another server holding a project of the same id, and taking the same credential.
    const other = mkdtempSync(join(tmpdir(), 'keito-collab-other-'));
    cpSync(data, other, { recursive: true });
    const elsewhere = await startServer(other);
    try {
      const b = await editor({ device: device.store, url: elsewhere.url });
      await b.stored();
      expect(at(b.node(seed.shape.id))).toEqual({ x: 240, y: 120 });
      b.session.dispose();
      const c = await editor({ url: elsewhere.url });
      expect(at(c.node(seed.shape.id))).toEqual({ x: 240, y: 120 });
    } finally {
      await elsewhere.kill();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('is not opened offline once the server last turned this device away', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    administer((store) => store.deleteProject(seed.id));
    await until(() => a.s().collab === null, 5_000, 'the delete to be heard');
    a.session.dispose();
    const down = server.url;
    await server.kill();

    const told = vi.spyOn(window, 'alert');
    const b = await editor({ device: device.store, url: down });
    expect(b.s().collab).toBeNull();
    expect(b.s().doc.id).toBe('local');
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/共同編集先に接続できません/));
  });

  it('keeps the edits two pages of this device made offline, and the next page opened sends both', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    const b = await editor({ device: device.store });
    const { port } = server;
    await server.kill();
    await a.offline();
    await b.offline();
    a.drag(seed.shape.id, 240, 120);
    const added = b.add('B が追加', 300);
    await until(() => a.s().collab?.device === 'saved' && b.s().collab?.device === 'saved', 5_000, 'both edits to be kept on this device');
    a.session.dispose();
    b.session.dispose();

    const c = await editor({ device: device.store });
    expect(c.s().collab?.pending).toBe(2);
    expect(at(c.node(seed.shape.id))).toEqual({ x: 240, y: 120 });
    expect(c.node(added.id)).toBeDefined();
    server = await startServer(data, port);
    await c.stored(15_000);
    const d = await editor();
    expect(at(d.node(seed.shape.id))).toEqual({ x: 240, y: 120 });
    expect(d.node(added.id)).toBeDefined();
  });

  it('sends no edit of a copy the server turned away, even once the server lets this device in again', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store });
    const { port } = server;
    await server.kill();
    await a.offline();
    a.drag(seed.shape.id, 300, 40);
    await until(() => a.s().collab?.device === 'saved', 5_000, 'the edit to be kept on this device');
    a.session.dispose();
    administer((store) => store.deleteProject(seed.id));
    server = await startServer(data, port);
    const told = vi.spyOn(window, 'alert');
    const asked = vi.spyOn(window, 'confirm');
    const b = await editor({ device: device.store });
    // Opened from the copy, then turned away: left as when turned away while open.
    await until(() => b.s().collab === null, 10_000, 'the delete to be heard');
    expect(b.s().doc.id).toBe('local');
    // Not asked whether to leave: the copy turned away is not sent, and nothing else would keep the edit.
    expect(asked).not.toHaveBeenCalled();
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/この共有案件は削除されています。この端末のボードに戻ります。\n.*変更 1 件は、保存されません/));
    b.session.dispose();

    administer((store) => store.restoreProject(seed.id));
    const c = await editor({ device: device.store });
    expect(c.s().collab?.link).toBe('online');
    expect(c.s().collab?.pending).toBe(0);
    expect(at(c.node(seed.shape.id))).toEqual({ x: 0, y: 0 });
    // Left on the device, for the user to take back.
    expect([...device.kept.values()].map((k) => k.pending.size)).toEqual([1]);
  });

  it('says when this device cannot keep an edit, asks before the page closes on it, and keeps it once the device can', async () => {
    const device = memoryDevice();
    const a = await editor({ device: device.store, page: true });
    await server.kill();
    await a.offline();
    device.failing = new DOMException('full', 'QuotaExceededError');
    a.drag(seed.shape.id, 300, 40);
    await until(() => a.s().saving === 'error', 5_000, 'the failed keep to be shown');
    expect(a.s().collab?.device).toBe('failed');
    expect(a.s().saveError).toMatch(/空き容量/);
    expect(at(a.node(seed.shape.id))).toEqual({ x: 300, y: 40 });
    expect(asksOnClose()).toBe(true);

    device.failing = null;
    await a.session.saveNow();
    await until(() => a.s().collab?.device === 'saved', 5_000, 'the edit to be kept on this device');
    // Kept here, still not on the server.
    expect(a.s().saving).toBe('saving');
    expect(asksOnClose()).toBe(false);
  });
});

describe('two editors reconnecting', () => {
  it('end with the same board as the server, through messages held up, sent twice, overtaken and cut off while both edit', async () => {
    const relay = await startRelay(server.url);
    try {
      const a = await editor({ device: memoryDevice().store, url: relay.url });
      const b = await editor({ device: memoryDevice().store, url: relay.url });
      relay.garble(true);
      a.drag(seed.shape.id, 100, 0);
      b.s().updateNode(seed.shape.id, { color: 'blue' });
      const fromA = a.add('A が追加', 200);

      relay.cut();
      await a.offline();
      await b.offline();
      // Offline: other things, and the same place of the same shape.
      const fromB = b.add('B が追加', 400);
      a.s().updateNode(fromA.id, { color: 'green' });
      a.drag(seed.shape.id, 200, 50);
      b.drag(seed.shape.id, 50, 200);

      relay.reopen();
      await a.stored(20_000);
      await b.stored(20_000);
      relay.garble(false);
      expect(relay.garbled().twice).toBeGreaterThan(0);
      expect(relay.garbled().overtaking).toBeGreaterThan(0);
      await until(() => JSON.stringify(nodesOf(a.s().doc)) === JSON.stringify(nodesOf(b.s().doc)), 10_000, 'both editors to show the same board');
      expect(nodesOf(a.s().doc).map((n) => n.id)).toEqual([seed.shape.id, fromA.id, fromB.id].sort());
      expect(a.node(fromA.id)).toMatchObject({ color: 'green' });
      expect(a.node(seed.shape.id)).toMatchObject({ color: 'blue' });

      await server.kill();
      server = await startServer(data);
      const c = await editor();
      expect(nodesOf(c.s().doc)).toEqual(nodesOf(a.s().doc));
    } finally {
      await relay.close();
    }
  });
});
