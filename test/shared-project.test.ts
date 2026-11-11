import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { openStore } from '../server/collab/store';
import { type ProjectSeed, SCHEMA, placeNodes } from '../src/collab/model';
import { writeCredential } from '../src/collab/protocol';
import type { Doc } from '../src/model/types';
import { type RunningServer, seedData, startServer, until } from './collab';
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

/** An editor on its own page, with its own local boards, showing the shared project. */
async function editor(url = server.url, credential = token) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession();
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '共有テスト' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: url, project: seed.id, token: credential });
  const s = () => session.useStore.getState();
  const shape = () => s().doc.nodes.find((n) => n.id === seed.shape.id);
  /** Drag the shape as the canvas does: an operation begun, moves shown as it goes, committed on letting go. */
  const drag = (x: number, y: number) => {
    s().checkpoint();
    s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === seed.shape.id ? { ...n, x: x / 2, y: y / 2 } : n)) }), false);
    s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === seed.shape.id ? { ...n, x, y } : n)) }), false);
    s().commitOperation();
  };
  return { session, disk, s, shape, drag };
}

/** Kill the server outright, start it again over the same data, and open the project in a new editor. */
async function afterRestart() {
  await server.kill();
  server = await startServer(data);
  return editor();
}

const at = (n: Doc['nodes'][number] | undefined) => n && { x: n.x, y: n.y };

describe('a shared project', () => {
  it('moves a shape for both editors, says saved only once stored, and keeps it through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    expect(a.s().collab?.project).toBe(seed.id);
    expect(at(b.shape())).toEqual({ x: 0, y: 0 });
    let resent = 0;
    b.session.useStore.subscribe((s) => void (resent = Math.max(resent, s.collab?.pending ?? 0)));

    a.drag(240, 120);
    await until(() => b.shape()?.x === 240, 5_000, 'the move to reach the other editor');
    expect(at(b.shape())).toEqual({ x: 240, y: 120 });
    expect(resent).toBe(0);
    await until(() => a.s().saving === 'saved', 5_000, 'the move to be confirmed');
    expect(a.s().collab?.pending).toBe(0);

    const c = await afterRestart();
    expect(at(c.shape())).toEqual({ x: 240, y: 120 });
  });

  it('turns away a client that knows the project id but holds no grant for it', async () => {
    const other = openStore(join(data, 'keito-collab.sqlite'));
    const elsewhere = other.initProject({ title: '別の案件', board: '配置', shape: '図形' });
    const stranger = other.addGrant(elsewhere.id).token;
    other.close();
    const told = vi.spyOn(window, 'alert');
    for (const credential of ['', 'not-a-grant', stranger]) {
      told.mockClear();
      const x = await editor(server.url, credential);
      expect(x.s().collab).toBeNull();
      expect(x.s().doc.id).toBe('local');
      expect(told).toHaveBeenCalledWith(expect.stringMatching(/参加の権限がないか/));
    }
  });

  it('takes edits only as commits, never from the sync alone', async () => {
    const { HocuspocusProvider } = await import('@hocuspocus/provider');
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: server.url, name: seed.id, document: ydoc, token: writeCredential({ token, schema: SCHEMA }) });
    try {
      await new Promise<void>((resolve) => provider.on('synced', () => resolve()));
      placeNodes(ydoc, seed.board.id, new Map([[seed.shape.id, { x: 500, y: 500 }]]), 'not a commit');
      // Nothing comes to wait for: what is checked is that the edit never arrives.
      await new Promise((r) => setTimeout(r, 500));
      const a = await editor();
      expect(at(a.shape())).toEqual({ x: 0, y: 0 });
    } finally {
      provider.destroy();
    }
  });

  it('leaves the board of this machine on screen when the server cannot be reached', async () => {
    const down = server.url;
    await server.kill();
    const told = vi.spyOn(window, 'alert');
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    sessions.push(session);
    const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
    await session.boot(disk.backend, { server: down, project: seed.id, token });
    expect(session.useStore.getState().collab).toBeNull();
    expect(session.useStore.getState().doc.id).toBe('local');
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/共同編集先に接続できません/));
  });

  it('stores an edit sent again under the same op id once', () => {
    const store = openStore(join(data, 'keito-collab.sqlite'));
    try {
      const update = Y.encodeStateAsUpdate(new Y.Doc());
      expect(store.commit(seed.id, 'op-1', update)).toBe('stored');
      expect(store.commit(seed.id, 'op-1', update)).toBe('known');
    } finally {
      store.close();
    }
  });

  it('keeps a move whose store failed, says so, and stores it on retry', async () => {
    const a = await editor();
    const lock = new DatabaseSync(join(data, 'keito-collab.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    try {
      a.drag(300, 40);
      await until(() => a.s().saving === 'error', 5_000, 'the failed store to be shown');
      expect(a.s().collab?.pending).toBe(1);
    } finally {
      lock.exec('COMMIT');
      lock.close();
    }
    await a.session.saveNow();
    await until(() => a.s().saving === 'saved', 5_000, 'the retried move to be confirmed');
    expect(a.s().collab?.pending).toBe(0);
    expect(at(a.shape())).toEqual({ x: 300, y: 40 });

    const c = await afterRestart();
    expect(at(c.shape())).toEqual({ x: 300, y: 40 });
  });

  it('keeps a move stored over the move of another editor that failed to store, through a killed server', async () => {
    const a = await editor();
    const b = await editor();
    const lock = new DatabaseSync(join(data, 'keito-collab.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    try {
      a.drag(300, 40);
      await until(() => a.s().saving === 'error', 5_000, 'the failed store to be shown');
      // Gone before it sends the move again: the move is never stored.
      a.session.dispose();
      // Nothing comes to wait for: what is checked is that the move never arrives.
      await new Promise((r) => setTimeout(r, 300));
      expect(at(b.shape())).toEqual({ x: 0, y: 0 });
    } finally {
      lock.exec('COMMIT');
      lock.close();
    }
    b.drag(80, 80);
    await until(() => b.s().saving === 'saved', 5_000, 'the move to be confirmed');

    const c = await afterRestart();
    expect(at(c.shape())).toEqual({ x: 80, y: 80 });
  });

  it('turns away edits a shared board does not take yet, and never writes it to the local store', async () => {
    const a = await editor();
    const b = await editor();
    const saved: string[] = [];
    const save = a.disk.backend.save;
    a.disk.backend.save = async (doc, force) => {
      saved.push(doc.id);
      return save(doc, force);
    };
    const exitSave = vi.fn();
    a.disk.backend.exitSave = exitSave;
    const saveRevision = vi.fn(async () => {});
    a.disk.backend.saveRevision = saveRevision;
    const before = a.s().doc;

    a.s().updateNode(seed.shape.id, { text: '書き換え' });
    a.s().removeIds([seed.shape.id]);
    a.s().setDoc({ ...before, meta: { ...before.meta, title: '全文で上書き' } });
    a.s().mutate((d) => ({ ...d, nodes: [...d.nodes, { ...d.nodes[0], id: 'added' }] }));
    a.s().undo();
    a.s().deleteBoard(seed.board.id);
    a.s().nameState('提出版');
    a.s().setTool('rect');
    expect(a.s().notice).toMatch(/共有中のボード/);
    expect(a.s().tool).toBe('select');
    a.disk.box.notify({ id: seed.board.id, serial: 99 });
    page.listeners.pagehide?.();
    await a.session.saveNow();
    // Nothing comes to wait for: what is checked is that no write happens.
    await new Promise((r) => setTimeout(r, 300));

    expect(a.s().doc).toEqual(before);
    expect(saved).not.toContain(seed.board.id);
    expect(exitSave).not.toHaveBeenCalled();
    expect(saveRevision).not.toHaveBeenCalled();
    expect(b.s().doc).toEqual(before);

    const c = await afterRestart();
    expect(c.s().doc).toEqual(before);
  });

  it('takes its tabs from the project, never from the boards of this machine with the same project name', async () => {
    const { boardAt } = await import('../src/ui/BoardTabs');
    const a = await editor();
    expect(a.s().boards.map((b) => b.project)).toContain(seed.title);
    expect(a.s().collab?.boards.map((b) => b.id)).toEqual([seed.board.id]);
    expect(boardAt(a.s().doc, a.s().boards, -1, a.s().collab?.boards)).toBe(seed.board.id);
  });

  it('lets go of the connection when a local board is opened, and saves that board as before', async () => {
    const a = await editor();
    const b = await editor();
    a.s().openBoard('local');
    await until(() => a.s().doc.id === 'local', 5_000, 'the local board to open');
    expect(a.s().collab).toBeNull();

    b.drag(80, 80);
    await until(() => b.s().saving === 'saved', 5_000, 'the move to be confirmed');
    expect(a.s().doc.id).toBe('local');

    a.s().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'ローカルで編集' } }));
    await a.session.saveNow();
    expect(a.disk.box.kept.get('local')?.doc.meta.title).toBe('ローカルで編集');
  });
});
