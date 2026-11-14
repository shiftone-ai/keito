import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import type { Backend } from '../src/platform/storage';
import { type RunningServer, administer, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

const sessions: Session[] = [];
/** What the desktop app's store says of shared projects (see platform/tauri.ts). */
const DESKTOP: Pick<Backend, 'device'> = { device: null };

beforeEach(() => {
  stubPage({ realTimers: true });
  // A page's IndexedDB that fails once used: a session keeping a shared project there says so.
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('IndexedDB used');
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a join link pasted into the app', () => {
  const join = { project: 'p-1', server: 'ws://localhost:1235', token: 'secret' };
  const link = `http://localhost:5183/#/s/${join.project}?${new URLSearchParams({ server: join.server, token: join.token })}`;

  it('names its project, server and credential, the project address alone opening it once they are kept', async () => {
    const { joinInAddress, keepJoin, readJoinLink } = await import('../src/collab/join');
    expect(readJoinLink(`  ${link}\n`)).toEqual(join);
    location.hash = `#/s/${join.project}`;
    expect(joinInAddress()).toBeNull();
    keepJoin(join);
    expect(joinInAddress()).toEqual(join);
  });

  it('is not taken for one without the credential, nor for another address', async () => {
    const { readJoinLink } = await import('../src/collab/join');
    expect(readJoinLink(`http://localhost:5183/#/s/${join.project}`)).toBeNull();
    expect(readJoinLink('http://localhost:5183/#/b/board-1')).toBeNull();
  });
});

describe('a shared project opened in the desktop app', () => {
  let data: string;
  let seed: ProjectSeed;
  let token: string;
  let server: RunningServer;

  beforeEach(async () => {
    ({ data, seed, token } = seedData());
    server = await startServer(data);
  });

  afterEach(async () => {
    sessions.splice(0).forEach((s) => s.dispose());
    await server.kill();
    rmSync(data, { recursive: true, force: true });
  });

  /** A window of the desktop app showing the project, over a folder with one board of this machine. */
  async function person(project = seed.id, credential = token) {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    sessions.push(session);
    const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
    await session.boot({ ...disk.backend, ...DESKTOP });
    expect(await session.openCollab({ server: server.url, project, token: credential })).toBe(true);
    const s = () => session.useStore.getState();
    const drag = (id: string, x: number, y: number) => {
      s().checkpoint();
      s().updateNode(id, { x, y }, false);
      s().commitOperation();
    };
    const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
    return { session, s, drag, stored };
  }

  it('is kept nowhere on this device, the app keeping no copy of shared projects yet', async () => {
    const desktop = await person();
    desktop.drag(seed.shape.id, 120, 60);
    await desktop.stored();
    expect(desktop.s().collab?.device).toBe('none');
  });

  it("gives way to another, whose edits reach the screen and the first one's no more", async () => {
    const other = administer(data, (store) => {
      const project = store.initProject({ title: '別の案件', board: '別のボード', shape: '別の図形' });
      return { project, token: store.addGrant(project.id).token };
    });
    const switching = await person();
    const first = await person();
    const second = await person(other.project.id, other.token);
    expect(await switching.session.openCollab({ server: server.url, project: other.project.id, token: other.token })).toBe(true);
    expect(switching.s().collab?.project).toBe(other.project.id);

    first.drag(seed.shape.id, 300, 300);
    second.drag(other.project.shape.id, 40, 40);
    await Promise.all([first.stored(), second.stored()]);
    const shape = () => switching.s().doc.nodes.find((n) => n.id === other.project.shape.id);
    await until(() => shape()?.x === 40, 5_000, "the second project's edit to arrive");
    expect(switching.s().doc.nodes.map((n) => n.id)).toEqual([other.project.shape.id]);
    expect(switching.s().collab?.project).toBe(other.project.id);
  });
});
