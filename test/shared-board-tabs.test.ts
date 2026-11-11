import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../server/collab/store';
import type { ProjectSeed } from '../src/collab/model';
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
  ({ data, seed, token } = seedData());
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** An editor on its own page, with a board of its own, showing the shared project. */
async function editor() {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession();
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: server.url, project: seed.id, token });
  const s = () => session.useStore.getState();
  const tabs = () => s().collab?.boards.map((b) => b.title).sort() ?? [];
  const manage = () => s().collab!.manage;
  const shape = () => s().doc.nodes.find((n) => n.id === seed.shape.id);
  /** Drag the shape as the canvas does: an operation begun, the move shown, committed on letting go. */
  const drag = (x: number, y: number) => {
    s().checkpoint();
    s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === seed.shape.id ? { ...n, x, y } : n)) }), false);
    s().commitOperation();
  };
  return { session, s, tabs, manage, shape, drag };
}

/** Kill the server outright, start it again over the same data, and open the project in a new editor. */
async function afterRestart() {
  await server.kill();
  server = await startServer(data);
  return editor();
}

const stored = (e: Awaited<ReturnType<typeof editor>>) => e.s().saving === 'saved' && !e.s().collab?.pending;

describe("a shared project's boards on screen", () => {
  it('adds a board for everyone and opens it for the one who added it, renames it, and keeps both through undo and a killed server', async () => {
    const a = await editor();
    const b = await editor();
    a.manage().add('音響', 'software');
    expect(a.s().doc.meta.title).toBe('音響');
    expect(a.s().doc.kind).toBe('software');
    const sound = a.s().doc.id;
    await until(() => b.tabs().includes('音響'), 5_000, 'the new board to reach the other editor');
    expect(b.s().doc.id).toBe(seed.board.id);

    b.s().openBoard(sound);
    a.manage().rename(sound, '音響（客席）');
    await until(() => b.s().doc.meta.title === '音響（客席）', 5_000, 'the rename to reach the board on screen');

    // Managing the boards is not drawing: undo takes back the move made before it, and leaves it be.
    a.s().openBoard(seed.board.id);
    a.drag(240, 120);
    a.manage().renameProject('会場B');
    await until(() => b.s().doc.meta.project === '会場B', 5_000, 'the project rename to reach the other editor');
    a.s().undo();
    expect(a.shape()).toMatchObject({ x: 0, y: 0 });
    expect(a.s().doc.meta.project).toBe('会場B');
    expect(a.tabs()).toEqual(['配置', '音響（客席）'].sort());
    await until(() => stored(a), 5_000, 'every change to be confirmed');

    const c = await afterRestart();
    expect(c.tabs()).toEqual(['配置', '音響（客席）'].sort());
    expect(c.s().doc.meta.project).toBe('会場B');
  });

  it('moves an editor off a board deleted by another, calling off the drag under way, and a restore brings the board back as it was', async () => {
    const a = await editor();
    const b = await editor();
    a.manage().add('照明', 'free');
    const light = a.s().doc.id;
    await until(() => b.tabs().includes('照明'), 5_000, 'the new board to reach the other editor');

    // A drag under way on the board when it goes.
    b.s().checkpoint();
    b.s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === seed.shape.id ? { ...n, x: 400, y: 400 } : n)) }), false);
    a.s().deleteBoard(seed.board.id);
    await until(() => b.s().doc.id === light, 5_000, 'the other editor to be moved to the board left');
    expect(b.s().notice).toMatch(/「配置」.*削除/);
    expect(b.s().selection).toEqual([]);
    b.s().commitOperation();
    expect(a.s().collab?.deleted.map((x) => x.id)).toEqual([seed.board.id]);

    a.manage().restore(seed.board.id);
    expect(a.s().doc.id).toBe(seed.board.id);
    expect(a.shape()).toMatchObject({ x: 0, y: 0 });
    await until(() => b.tabs().includes('配置'), 5_000, 'the restore to reach the other editor');
    expect(b.s().doc.id).toBe(light);
  });

  it('shows an empty project once its last board is deleted, takes no drawing there, and opens a board added or restored by anyone', async () => {
    const a = await editor();
    const b = await editor();
    a.s().deleteBoard(seed.board.id);
    expect(a.s().collab?.boards).toEqual([]);
    expect(a.s().doc.nodes).toEqual([]);
    await until(() => b.s().collab?.boards.length === 0, 5_000, 'the delete to reach the other editor');
    expect(b.s().doc.nodes).toEqual([]);
    expect(b.s().collab?.takes('rect')).toBe(false);
    b.s().setTool('rect');
    expect(b.s().tool).toBe('select');

    a.manage().restore(seed.board.id);
    expect(a.s().doc.id).toBe(seed.board.id);
    await until(() => b.s().doc.id === seed.board.id, 5_000, 'the restored board to open for the other editor');
    await until(() => stored(a), 5_000, 'every change to be confirmed');

    a.s().deleteBoard(seed.board.id);
    await until(() => stored(a), 5_000, 'the delete to be confirmed');
    const c = await afterRestart();
    expect(c.s().collab?.boards).toEqual([]);
    expect(c.s().collab?.deleted.map((x) => x.id)).toEqual([seed.board.id]);
  });

  it('opens the project again on the board last shown on this machine, and each board on the view it was left with', async () => {
    const a = await editor();
    // The first tab (a software board goes before a free one), not the board left on screen.
    a.manage().add('音響', 'software');
    const sound = a.s().doc.id;
    a.s().setView({ x: 10, y: 20, k: 2 });
    a.s().openBoard(seed.board.id);
    a.s().setView({ x: -5, y: 0, k: 0.5 });
    a.s().openBoard(sound);
    expect(a.s().view).toEqual({ x: 10, y: 20, k: 2 });
    a.s().openBoard(seed.board.id);
    expect(a.s().view).toEqual({ x: -5, y: 0, k: 0.5 });
    a.session.dispose();

    const again = await editor();
    expect(again.s().doc.id).toBe(seed.board.id);
  });

  it('leaves for the board of this machine and says so when the project is deleted while open', async () => {
    const told = vi.spyOn(window, 'alert');
    const a = await editor();
    const store = openStore(join(data, 'keito-collab.sqlite'));
    try {
      store.deleteProject(seed.id);
    } finally {
      store.close();
    }
    await until(() => a.s().doc.id === 'local', 5_000, 'the board of this machine to come back');
    expect(a.s().collab).toBeNull();
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/この共有案件は削除されています/));
  });
});
