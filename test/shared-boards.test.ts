import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { openStore } from '../server/collab/store';
import { type SharedProject, joinProject } from '../src/collab/client';
import { type ProjectSeed, SCHEMA, boardList, deleteBoard, restoreBoard, seedProject } from '../src/collab/model';
import { readAnswer, writeCommit, writeCredential } from '../src/collab/protocol';
import { type RunningServer, seedData, startServer, until } from './collab';

let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
const joined: SharedProject[] = [];

beforeEach(async () => {
  ({ data, seed, token } = seedData());
  server = await startServer(data);
});

afterEach(async () => {
  joined.splice(0).forEach((p) => p.close());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
});

/** A client of the shared project, once the server has sent it. */
async function client(): Promise<SharedProject> {
  const project = joinProject({ server: server.url, project: seed.id, token });
  joined.push(project);
  await project.ready;
  return project;
}

const titles = (p: SharedProject): string[] => p.boards().map((b) => b.title);
const stored = (p: SharedProject): boolean => !p.status().pending && !p.status().failure;

/** Kill the server outright, start it again over the same data, and open the project in a new client. */
async function afterRestart(): Promise<SharedProject> {
  await server.kill();
  server = await startServer(data);
  return client();
}

/** Do to the project what the administration commands (npm run collab) do, while the server runs. */
function administer(fn: (store: ReturnType<typeof openStore>) => void): void {
  const store = openStore(join(data, 'keito-collab.sqlite'));
  try {
    fn(store);
  } finally {
    store.close();
  }
}

describe("a shared project's boards", () => {
  it('keeps two boards made at once, and a rename, through a killed server', async () => {
    const a = await client();
    const b = await client();
    const one = a.addBoard('音響', 'software')!;
    const two = b.addBoard('照明', 'free')!;
    expect(one).not.toBe(two);
    await until(() => a.boards().length === 3 && b.boards().length === 3, 5_000, 'both new boards to reach both clients');
    a.renameBoard(two, '照明（客席）');
    await until(() => titles(b).includes('照明（客席）'), 5_000, 'the rename to reach the other client');
    a.renameProject('会場B');
    await until(() => b.title() === '会場B', 5_000, 'the project rename to reach the other client');
    await until(() => stored(a) && stored(b), 5_000, 'every edit to be confirmed');

    const c = await afterRestart();
    expect(titles(c).sort()).toEqual(['照明（客席）', '配置', '音響'].sort());
    expect(c.boards().find((x) => x.id === one)?.kind).toBe('software');
    expect(c.title()).toBe('会場B');
  });

  it('keeps a project whose last board was deleted, and opens it empty after a restart', async () => {
    const a = await client();
    a.removeBoard(seed.board.id);
    expect(a.boards()).toEqual([]);
    expect(a.board(seed.board.id)).toBeNull();
    await until(() => stored(a), 5_000, 'the delete to be confirmed');

    const c = await afterRestart();
    expect(c.boards()).toEqual([]);
    expect(c.deletedBoards().map((x) => x.id)).toEqual([seed.board.id]);
  });

  it('does not bring a deleted board back for an edit made on it before the delete was seen, until it is restored', async () => {
    const live = new Y.Doc();
    const provider = new HocuspocusProvider({ url: server.url, name: seed.id, document: live, token: writeCredential({ token, schema: SCHEMA }) });
    try {
      await new Promise<void>((resolve) => provider.on('synced', () => resolve()));
      // A client that read the project before the delete, and edits the board after it, unaware.
      const stale = new Y.Doc();
      Y.applyUpdate(stale, Y.encodeStateAsUpdate(live));
      const a = await client();
      a.removeBoard(seed.board.id);
      await until(() => stored(a), 5_000, 'the delete to be confirmed');

      const before = Y.encodeStateVector(stale);
      stale.getMap<Y.Map<unknown>>('boards').get(seed.board.id)?.set('title', '古い名前');
      const answer = new Promise<string>((resolve) => provider.on('stateless', ({ payload }: { payload: string }) => resolve(readAnswer(payload)?.type ?? '')));
      provider.sendStateless(writeCommit('stale-rename', Y.encodeStateAsUpdate(stale, before)));
      expect(await answer).toBe('saved');
      expect(boardList(live)).toEqual([]);

      const c = await afterRestart();
      expect(c.boards()).toEqual([]);
      c.restoreBoard(seed.board.id);
      expect(titles(c)).toEqual(['古い名前']);
      await until(() => stored(c), 5_000, 'the restore to be confirmed');
      const d = await client();
      expect(d.board(seed.board.id)?.nodes.map((n) => n.id)).toEqual([seed.shape.id]);
    } finally {
      provider.destroy();
    }
  });

  it('lets a client go when its project is deleted, stores nothing sent after, and keeps what it held for a restore', async () => {
    const a = await client();
    a.renameBoard(seed.board.id, '消す前');
    await until(() => stored(a), 5_000, 'the rename to be confirmed');
    administer((store) => store.deleteProject(seed.id));
    a.renameBoard(seed.board.id, '消した後');
    await until(() => a.status().link === 'refused', 5_000, 'the client to hear of the delete');
    expect(a.status().refusal).toBe('deleted');

    administer((store) => store.restoreProject(seed.id));
    const c = await client();
    expect(titles(c)).toEqual(['消す前']);
  });

  it('turns away a client reconnecting, or joining, while its project is deleted', async () => {
    const a = await client();
    const port = Number(new URL(server.url).port);
    await server.kill();
    administer((store) => store.deleteProject(seed.id));
    server = await startServer(data, port);
    await until(() => a.status().link === 'refused', 10_000, 'the reconnecting client to be turned away');
    expect(a.status().refusal).toBe('deleted');

    const late = joinProject({ server: server.url, project: seed.id, token });
    joined.push(late);
    await expect(late.ready).rejects.toThrow(/削除されています/);
  });

  it('does not tell a client without a grant whether a project was deleted', async () => {
    administer((store) => store.deleteProject(seed.id));
    const stranger = joinProject({ server: server.url, project: seed.id, token: 'not-a-grant' });
    joined.push(stranger);
    await expect(stranger.ready).rejects.toThrow(/参加の権限がないか/);
    expect(stranger.status().refusal).toBe('no-access');
  });
});

describe('a board deleted by two editors at once', () => {
  // Yjs settles two values written to one key by the writers' client ids: both orders are tried.
  it.each([
    [1, 2],
    [2, 1],
  ])('stays deleted for everyone when a third editor restores it having seen one delete (client ids %i and %i)', (first, second) => {
    const start = new Y.Doc();
    seedProject(start, { id: 'p', title: '案件', board: { id: 'b', title: '配置' }, shape: { id: 's', text: '', x: 0, y: 0, w: 10, h: 10 } });
    const editors = [first, second, 3].map((clientID) => {
      const ydoc = new Y.Doc();
      ydoc.clientID = clientID;
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(start));
      return ydoc;
    });
    const [a, b, c] = editors;
    deleteBoard(a, 'b', null);
    deleteBoard(b, 'b', null);
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    restoreBoard(c, 'b', null);
    for (const to of editors) for (const from of editors) Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
    expect(editors.map(boardList)).toEqual([[], [], []]);
  });
});
