import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { authenticate, authorize } from '../server/collab/access';
import { joinProject } from '../src/collab/client';
import { SCHEMA, type ProjectSeed } from '../src/collab/model';
import { readAccess, readAnswer, readLetGo, writeCommit, writeCredential } from '../src/collab/protocol';
import type { Role } from '../src/collab/protocol';
import { boardNodes } from '../src/collab/boards';
import { noEdit } from '../src/collab/edits';
import { writeNodes } from '../src/collab/nodes';
import { administer, memoryDevice, type RunningServer, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
/** The editor's invite of seedData. */
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


/** A new invite to the project, as `invite` makes it. */
const invite = (role: Role, project = seed.id) => administer(data, (store) => store.addGrant(project, role));

/** Someone on a page of their own, showing the shared project joined with `credential`. */
async function person(credential: string, device = memoryDevice().store) {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession({ device });
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: server.url, project: seed.id, token: credential });
  const s = () => session.useStore.getState();
  const shape = () => s().doc.nodes.find((n) => n.id === seed.shape.id);
  /** Drag the shape as the canvas does: an operation begun, moves shown as it goes, committed on letting go. */
  const drag = (x: number, y: number) => {
    s().checkpoint();
    s().updateNode(seed.shape.id, { x: x / 2, y: y / 2 }, false);
    s().updateNode(seed.shape.id, { x, y }, false);
    s().commitOperation();
  };
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { session, s, shape, drag, stored };
}

/** A client speaking to the server directly, as a page changed by its user could. */
async function direct(credential: string, heard: string[] = []) {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: server.url, name: seed.id, document: ydoc, token: writeCredential({ token: credential, schema: SCHEMA }) });
  providers.push(provider);
  provider.on('stateless', ({ payload }: { payload: string }) => heard.push(payload));
  await new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  /** Send a move of the shape to (x, y) as a commit, as the app sends its edits. */
  const commit = (op: string, x: number, y: number) => {
    const probe = new Y.Doc();
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(ydoc));
    const before = Y.encodeStateVector(probe);
    writeNodes(boardNodes(probe, seed.board.id)!, { ...noEdit(), set: new Map([[seed.shape.id, { x, y }]]) });
    provider.sendStateless(writeCommit(op, Y.encodeStateAsUpdate(probe, before)));
  };
  return { ydoc, provider, heard, commit };
}

const at = (n: { x: number; y: number } | undefined) => n && { x: n.x, y: n.y };

/** Where the shape is as stored: read by a new editor, after the server is killed and started again. */
async function storedPlace() {
  await server.kill();
  server = await startServer(data);
  return at((await person(token)).shape());
}

describe('invites', () => {
  it("let a viewer see an editor's moves as they come, and nothing more", async () => {
    const a = await person(token);
    const v = await person(invite('viewer').token);
    expect(a.s().collab?.role).toBe('editor');
    expect(v.s().collab?.role).toBe('viewer');
    expect(v.s().collab?.project).toBe(seed.id);

    a.drag(240, 120);
    await until(() => at(v.shape())?.x === 240, 5_000, "the editor's move to reach the viewer");

    v.drag(10, 10);
    expect(at(v.shape())).toEqual({ x: 240, y: 120 });
    expect(v.s().notice).toMatch(/閲覧のみ/);
    expect(v.s().collab?.takes('rect')).toBe(false);
    expect(v.s().collab?.pending).toBe(0);
    await a.stored();
    expect(await storedPlace()).toEqual({ x: 240, y: 120 });
  });

  it("turn away a viewer's edit sent to the server directly, whatever name and colour it shows", async () => {
    const a = await person(token);
    const v = await direct(invite('viewer').token);
    expect(v.heard.map(readAccess)).toContain('viewer');
    v.provider.setAwarenessField('user', { name: a.s().doc.meta.project, color: 'red', role: 'editor' });
    // Through Yjs's own sync, and as a commit.
    v.ydoc.transact(() => writeNodes(boardNodes(v.ydoc, seed.board.id)!, { ...noEdit(), set: new Map([[seed.shape.id, { x: 400, y: 400 }]]) }), 'not a commit');
    v.commit('viewer-op', 500, 500);
    await until(() => v.heard.some((p) => readAnswer(p)?.op === 'viewer-op'), 5_000, "the viewer's commit to be answered");
    expect(v.heard.map(readAnswer).find((x) => x?.op === 'viewer-op')).toEqual({ type: 'refused', op: 'viewer-op', reason: 'read-only' });
    expect(at(a.shape())).toEqual({ x: 0, y: 0 });
    expect(await storedPlace()).toEqual({ x: 0, y: 0 });
  });

  it('let go of the sessions of a revoked invite at once, and turn away its later edits and reconnects', async () => {
    const mine = invite('editor');
    const told = vi.spyOn(window, 'alert');
    const device = memoryDevice();
    const a = await person(mine.token, device.store);
    const b = await person(token);
    const raw = await direct(mine.token);

    administer(data, (store) => store.revokeGrant(mine.id));
    // Sent before the server has looked for revoked invites: refused all the same.
    raw.commit('after-revoke', 500, 500);
    await until(() => raw.heard.some((p) => readLetGo(p) === 'revoked'), 5_000, 'the raw client to be let go');
    expect(raw.heard.map(readAnswer).some((x) => x?.op === 'after-revoke' && x.type === 'saved')).toBe(false);
    expect(at(b.shape())).toEqual({ x: 0, y: 0 });
    await until(() => a.s().collab === null, 5_000, 'the page to leave the project');
    expect(a.s().doc.id).toBe('local');
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/招待は取り消されました/));

    const again = joinProject({ server: server.url, project: seed.id, token: mine.token });
    await expect(again.ready).rejects.toThrow(/招待は取り消されました/);
    expect(again.status().refusal).toBe('revoked');
    again.close();
    // The copy kept before the revoke does not open as editable again.
    const back = joinProject({ server: server.url, project: seed.id, token: mine.token }, device.store);
    await expect(back.ready).rejects.toThrow(/招待は取り消されました/);
    back.close();

    expect(b.s().collab?.link).toBe('online');
    b.drag(80, 80);
    await b.stored();
    expect(await storedPlace()).toEqual({ x: 80, y: 80 });
  });

  it('keep their secrets out of the server output, the document, presence and exports', async () => {
    await server.kill();
    const output: string[] = [];
    server = await startServer(data, 0, output);
    const viewer = invite('viewer');
    const a = await person(token);
    const observer = await direct(viewer.token);
    a.drag(240, 120);
    await a.stored();
    // Whatever the others show of themselves, as the observer has it.
    const presence = JSON.stringify([...observer.provider.awareness!.getStates().values()]);
    const stranger = joinProject({ server: server.url, project: seed.id, token: 'not-an-invite' });
    await stranger.ready.catch(() => {});
    stranger.close();
    administer(data, (store) => store.revokeGrant(viewer.id));
    await until(() => observer.heard.some((p) => readLetGo(p) === 'revoked'), 5_000, 'the revoked observer to be let go');
    await server.kill();

    const secrets = [token, viewer.token];
    const seen = {
      output: output.join('\n'),
      stored: readFileSync(join(data, 'keito-collab.sqlite')).toString('latin1'),
      document: Buffer.from(Y.encodeStateAsUpdate(observer.ydoc)).toString('latin1'),
      presence,
      exported: JSON.stringify(a.s().doc),
    };
    expect(seen.output).toMatch(/revoked/);
    for (const [where, text] of Object.entries(seen)) for (const secret of secrets) expect(text.includes(secret), where).toBe(false);
  });
});

describe('the access contract', () => {
  it('lets an invite do with its project only what its role allows, while it is not revoked and the project not deleted', () => {
    administer(data, (store) => {
      const elsewhere = store.initProject({ title: '別の案件', board: '配置', shape: '図形' });
      const editor = store.grantOf(token);
      const viewer = store.addGrant(seed.id, 'viewer');
      const ask = (secret: string, project: string, need: 'view' | 'edit') => {
        const a = authorize(store, authenticate(store, secret), project, need);
        return a.ok ? a.role : a.denial;
      };
      expect(ask(token, seed.id, 'edit')).toBe('editor');
      expect(ask(viewer.token, seed.id, 'view')).toBe('viewer');
      expect(ask(viewer.token, seed.id, 'edit')).toBe('read-only');
      expect(ask(token, elsewhere.id, 'view')).toBe('no-access');
      expect(ask('not-an-invite', seed.id, 'view')).toBe('no-access');
      expect(ask('', seed.id, 'view')).toBe('no-access');
      store.deleteProject(seed.id);
      expect(ask(token, seed.id, 'view')).toBe('deleted');
      store.revokeGrant(editor!);
      expect(ask(token, seed.id, 'view')).toBe('revoked');
    });
  });
});

describe('the administration commands', () => {
  const collab = (...args: string[]) => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'server/collab/cli.ts', ...args, '--data', data], { encoding: 'utf8' });
    return { code: run.status, out: run.stdout, err: run.stderr };
  };

  it('issue an invite of the role asked for, list it, and revoke it', async () => {
    const made = collab('invite', seed.id, '--role', 'viewer', '--server', server.url, '--app', 'http://localhost:5183/');
    expect(made.code).toBe(0);
    const secret = /token: (\S+)/.exec(made.out)![1];
    const id = /招待を作りました: (\S+)/.exec(made.out)![1];
    expect(made.out).toContain(`#/s/${seed.id}?server=`);
    const v = joinProject({ server: server.url, project: seed.id, token: secret });
    await v.ready;
    expect(v.status().role).toBe('viewer');

    expect(collab('invites', seed.id).out).toMatch(new RegExp(`${id}\\s+閲覧`));
    expect(collab('revoke', id).code).toBe(0);
    await until(() => v.status().link === 'refused', 5_000, 'the viewer to be let go');
    v.close();
    expect(collab('invites', seed.id).out).toMatch(new RegExp(`${id}\\s+閲覧.*取り消し`));
    expect(collab('invite', seed.id).code).toBe(2);
  });

  it('refuse to run over a data folder other users can open', () => {
    chmodSync(data, 0o755);
    const run = collab('invites', seed.id);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/chmod 700/);
  });
});
