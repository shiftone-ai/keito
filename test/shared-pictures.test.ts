import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { type PictureBody, type PictureDevice, type PictureStatus } from '../src/collab/pictures';
import { MAX_PICTURE_BYTES, pictureAddress, sharedName } from '../src/collab/pictureRef';
import type { Role } from '../src/collab/protocol';
import { allIds } from '../src/model/ids';
import { makeImage } from '../src/model/presets';
import type { Node } from '../src/model/types';
import { assetOf } from '../src/platform/storage';
import { type RunningServer, administer, memoryDevice, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
/** The editor's invite of seedData. */
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

/** A picture of its own (an SVG, as a picture read from a file is), as a data URL, and its bytes. */
function picture(text: string): { dataUrl: string; bytes: Uint8Array<ArrayBuffer> } {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text y="15">${text}</text></svg>`;
  return { dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, bytes: new TextEncoder().encode(svg) };
}
const nameOf = (bytes: Uint8Array): string => `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.svg`;

/** What a device keeps of the pictures of shared projects, in memory as a browser holds IndexedDB across reloads. While `failing` is set, every write fails with it. */
function memoryPictures() {
  const bodies = new Map<string, PictureBody>();
  const unsent = new Set<string>();
  /** `failing`: every write fails so; `hold`: every write waits for it. */
  const device = { bodies, unsent, failing: null as Error | null, hold: null as Promise<void> | null };
  const store: PictureDevice = {
    load: async (key) => structuredClone(bodies.get(key) ?? null),
    async keep(key, body, isUnsent) {
      await Promise.resolve();
      await device.hold;
      if (device.failing) throw device.failing;
      bodies.set(key, structuredClone(body));
      if (isUnsent) unsent.add(key);
    },
    async sent(key) {
      unsent.delete(key);
    },
    unsent: async (prefix) => [...unsent].filter((key) => key.startsWith(prefix)),
  };
  return Object.assign(device, { store });
}

/** The pictures the server keeps for a project, as files. */
const kept = (project = seed.id): string[] => {
  try {
    return readdirSync(join(data, 'pictures', project));
  } catch {
    return [];
  }
};

/**
 * Picture requests of one page (`who`, the path its server address carries) held up, answered with an
 * error, or cut on the way, as a slow or broken network would; the rest go through. Counts what went
 * through by method.
 */
function network() {
  const real = globalThis.fetch;
  const rules = new Map<string, 'hold' | 'cut' | number>();
  const waiting: (() => void)[] = [];
  const through = new Map<string, number>();
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const m = /^\/(\w+)\/pictures\//.exec(url.pathname);
    const key = m && `${m[1]} ${init?.method ?? 'GET'}`;
    let rule = key ? rules.get(key) : undefined;
    // Held, it then meets whatever the rule is by the time it is let go.
    while (rule === 'hold') {
      await new Promise<void>((resolve) => waiting.push(resolve));
      rule = rules.get(key!);
    }
    if (rule === 'cut') throw new TypeError('fetch failed');
    else if (typeof rule === 'number') return new Response('{}', { status: rule });
    if (key) through.set(key, (through.get(key) ?? 0) + 1);
    return real(input, init);
  });
  return {
    /** Set what becomes of `who`'s requests of `method` from now on (undefined: they go through). */
    set(who: string, method: 'GET' | 'PUT', rule: 'hold' | 'cut' | number | undefined) {
      if (rule === undefined) rules.delete(`${who} ${method}`);
      else rules.set(`${who} ${method}`, rule);
    },
    /** Let the held requests go on, to meet the rule set now. */
    release() {
      waiting.splice(0).forEach((go) => go());
    },
    held: () => waiting.length,
    through: (who: string, method: 'GET' | 'PUT') => through.get(`${who} ${method}`) ?? 0,
  };
}

/**
 * Someone on a page of their own, showing the shared project joined with `credential`, with a cache
 * of its own (`pictures`). `who` names the page in the address of its server, for `network`.
 */
async function person(who: string, options: { credential?: string; device?: ReturnType<typeof memoryDevice>; pictures?: ReturnType<typeof memoryPictures> } = {}) {
  const { createEditSession } = await import('../src/model/store');
  const device = options.device ?? memoryDevice();
  const pictures = options.pictures ?? memoryPictures();
  const session = createEditSession({ device: device.store, pictures: pictures.store });
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: `${server.url}/${who}`, project: seed.id, token: options.credential ?? token });
  const s = () => session.useStore.getState();
  const shown = () => s().collab!.pictures;
  /** Put a picture on the board as insertImages does: kept for the board first, then put there as one step. */
  const insert = async (dataUrl: string, x = 300, y = 200): Promise<Node> => {
    const src = await session.storeImage(dataUrl);
    let made: Node | undefined;
    s().mutate((d) => {
      made = makeImage(allIds(d), { src, w: 40, h: 20, name: '図' }, x, y);
      return { ...d, nodes: [...d.nodes, made] };
    });
    return made!;
  };
  const images = () => s().doc.nodes.filter((n) => n.type === 'image');
  /** How a picture of the board stands, watched as the screen watches it (which fetches it); `seen` records each status it takes. */
  const watch = (name: string, seen: PictureStatus[] = []) => {
    const hear = () => {
      const status = shown().view(name).status;
      if (seen.at(-1) !== status) seen.push(status);
    };
    hear();
    const stop = shown().watch(name, hear);
    return { seen, stop, status: () => shown().view(name).status };
  };
  const bytes = async (name: string) => new Uint8Array(await (await shown().read(name)).arrayBuffer());
  const stored = (ms = 5_000) => until(() => s().saving === 'saved' && s().collab?.pending === 0, ms, `${who}'s edits and pictures to be stored`);
  return { session, s, device, pictures, insert, images, watch, bytes, stored };
}

const srcOf = (n: Node | undefined): string => (n?.type === 'image' ? n.src : '');
const invite = (role: Role, project = seed.id) => administer(data, (store) => store.addGrant(project, role));
/** A request for a picture of a project, as an app would make it, with an invite's secret (none, without one). */
const request = (project: string, name: string, secret: string | null, init: RequestInit = {}) =>
  fetch(pictureAddress(server.url, project, name), { ...init, headers: { ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }), ...init.headers } });
const put = (project: string, bytes: Uint8Array<ArrayBuffer>, secret: string | null, name = nameOf(bytes)) => request(project, name, secret, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'image/svg+xml' } });
const reason = async (res: Response) => ({ status: res.status, reason: ((await res.json()) as { reason?: string }).reason });

describe('the pictures of a shared project on the server', () => {
  it("keep a picture an editor sends, give it to a viewer of the project, and still have it after the server is killed", async () => {
    const { bytes } = picture('一');
    const name = nameOf(bytes);
    expect((await put(seed.id, bytes, token)).status).toBe(204);
    // Sent again (a resend after a lost answer): kept once.
    expect((await put(seed.id, bytes, token)).status).toBe(204);
    expect(kept()).toEqual([name]);

    await server.kill();
    server = await startServer(data, server.port);
    const viewer = invite('viewer');
    const res = await request(seed.id, name, viewer.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("turn away a viewer's picture, another project's invite, a name without an invite, and a revoked or deleted project's invite", async () => {
    const { bytes } = picture('二');
    const name = nameOf(bytes);
    const viewer = invite('viewer');
    expect(await reason(await put(seed.id, bytes, viewer.token))).toEqual({ status: 403, reason: 'read-only' });
    expect(kept()).toEqual([]);
    expect((await put(seed.id, bytes, token)).status).toBe(204);

    const other = administer(data, (store) => {
      const project = store.initProject({ title: '別の案件', board: '配置', shape: '図形' });
      return { project: project.id, token: store.addGrant(project.id).token };
    });
    // Another project's editor, asking by this project's address, and by its own (the name alone finds nothing there).
    expect(await reason(await request(seed.id, name, other.token))).toEqual({ status: 403, reason: 'no-access' });
    expect(await reason(await request(other.project, name, other.token))).toEqual({ status: 404, reason: 'missing' });
    expect(await reason(await put(seed.id, picture('別').bytes, other.token))).toEqual({ status: 403, reason: 'no-access' });
    // The name alone, or with a made-up secret.
    expect(await reason(await request(seed.id, name, null))).toEqual({ status: 403, reason: 'no-access' });
    expect(await reason(await request(seed.id, name, 'guessed'))).toEqual({ status: 403, reason: 'no-access' });

    administer(data, (store) => store.revokeGrant(store.grantOf(viewer.token)!));
    expect(await reason(await request(seed.id, name, viewer.token))).toEqual({ status: 403, reason: 'revoked' });
    administer(data, (store) => store.deleteProject(seed.id));
    expect(await reason(await request(seed.id, name, token))).toEqual({ status: 403, reason: 'deleted' });
  });

  it('turn away bytes that are not the picture the name says, and a name that is no picture’s', async () => {
    const { bytes } = picture('三');
    expect(await reason(await put(seed.id, bytes, token, nameOf(picture('四').bytes)))).toEqual({ status: 400, reason: 'mismatch' });
    expect(await reason(await put(seed.id, bytes, token, '../keito-collab.sqlite'))).toEqual({ status: 400, reason: 'malformed' });
    expect(kept()).toEqual([]);
  });
});

describe('pictures on a shared board', () => {
  it('are shown to someone who has no copy of them, moved and taken off for everyone, and undone by whoever put them there only', async () => {
    const a = await person('a');
    const b = await person('b');
    const { dataUrl, bytes } = picture('配置図');
    const placed = await a.insert(dataUrl);
    const name = sharedName(srcOf(placed))!;
    expect(name).toBe(nameOf(bytes));
    await a.stored();
    expect(a.watch(name).status()).toBe('shown');

    await until(() => b.images().length === 1, 5_000, 'the picture to reach b');
    const seen = b.watch(name);
    await until(() => seen.status() === 'shown', 5_000, 'b to fetch the picture');
    expect(await b.bytes(name)).toEqual(bytes);
    expect(b.pictures.bodies.size).toBe(1);

    // Moved by b (as the canvas drags it), taken off by a's undo of its own step: b's move stays undone with it.
    b.s().checkpoint();
    b.s().updateNode(placed.id, { x: 500, y: 300 }, false);
    b.s().commitOperation();
    await b.stored();
    await until(() => a.images()[0]?.x === 500, 5_000, "b's move to reach a");
    a.s().undo();
    await until(() => b.images().length === 0, 5_000, "a's undo to reach b");
    expect(a.images()).toEqual([]);
    b.s().undo();
    expect(b.images()).toEqual([]);
    a.s().redo();
    await until(() => b.images().length === 1, 5_000, "a's redo to reach b");

    a.s().removeIds([placed.id]);
    await until(() => b.images().length === 0, 5_000, "a's delete to reach b");
    await a.stored();
  });

  it('show that the picture has not come yet when the board comes before it, and show it once it is sent', async () => {
    const net = network();
    net.set('a', 'PUT', 'hold');
    const a = await person('a');
    const b = await person('b');
    const placed = await a.insert(picture('先に届く').dataUrl);
    const name = sharedName(srcOf(placed))!;
    await until(() => b.images().length === 1, 5_000, 'the board to reach b');
    const seen = b.watch(name);
    await until(() => seen.status() === 'waiting', 5_000, 'b to find the picture not there yet');
    expect(a.watch(name).status()).toBe('sending');
    expect(a.s().saving).toBe('saving');
    net.set('a', 'PUT', undefined);
    net.release();
    await until(() => seen.status() === 'shown', 15_000, 'b to fetch the picture once it is sent');
    await a.stored();
  });

  it('tell an unsent picture from one failing to send and one sent again, send it once, and never bring back a picture taken off meanwhile', async () => {
    const net = network();
    net.set('a', 'PUT', 'hold');
    const a = await person('a');
    const b = await person('b');
    const { dataUrl } = picture('再送');
    const placed = await a.insert(dataUrl);
    const name = sharedName(srcOf(placed))!;
    const seen = a.watch(name).seen;
    net.set('a', 'PUT', 503);
    net.release();
    await until(() => a.s().saving === 'error', 5_000, 'the send to fail');
    expect(a.s().saveError).toMatch(/画像/);
    expect(a.watch(name).status()).toBe('failed');
    // Sent again and failing again: told as failing throughout, not as being stored between the tries.
    const told: string[] = [];
    const off = a.session.useStore.subscribe((st) => void told.push(st.saving));
    await until(() => seen.includes('resending') && seen.at(-1) === 'failed', 5_000, 'the picture to be sent again and fail again');
    off();
    expect(told.filter((saving) => saving !== 'error')).toEqual([]);

    // Offline: not sent, and not failed either.
    net.set('a', 'PUT', 'cut');
    void a.session.saveNow();
    await until(() => a.watch(name).status() === 'unsent', 5_000, 'the picture to wait to be sent');

    // Taken off while it is still to be sent (by someone else): the send that follows does not bring it back.
    await until(() => b.images().length === 1, 5_000, 'the board to reach b');
    b.s().removeIds([placed.id]);
    await until(() => a.images().length === 0, 5_000, "b's delete to reach a");
    net.set('a', 'PUT', undefined);
    void a.session.saveNow();
    await a.stored();
    // Each told apart, in the order first seen (the waits between tries repeat some of them).
    expect([...new Set(seen)]).toEqual(['sending', 'failed', 'resending', 'unsent', 'shown']);
    expect(a.images()).toEqual([]);
    expect(b.images()).toEqual([]);
    expect(kept()).toEqual([name]);
    expect(net.through('a', 'PUT')).toBe(1);

    // Put there again (the same picture): nothing more to send.
    await a.insert(dataUrl);
    await a.stored();
    expect(net.through('a', 'PUT')).toBe(1);
  });

  it('keep a picture put on the board offline on the device, and send it once after the page is opened again', async () => {
    const device = memoryDevice();
    const pictures = memoryPictures();
    const a = await person('a', { device, pictures });
    await server.kill();
    await until(() => a.s().collab?.link === 'offline', 5_000, 'the server to be missed');
    const { dataUrl, bytes } = picture('オフライン');
    const placed = await a.insert(dataUrl);
    const name = sharedName(srcOf(placed))!;
    const status = a.watch(name).status;
    await until(() => status() === 'unsent', 5_000, 'the picture to wait to be sent');
    await until(() => a.s().collab?.device === 'saved', 5_000, 'the edit to be kept on the device');
    expect(a.s().collab?.pending).toBe(2);
    expect(pictures.unsent.size).toBe(1);
    sessions.splice(sessions.indexOf(a.session), 1);
    a.session.dispose();

    server = await startServer(data, server.port);
    const again = await person('a', { device, pictures });
    await again.stored(15_000);
    expect(again.images().map((n) => n.id)).toEqual([placed.id]);
    expect(pictures.unsent.size).toBe(0);
    expect(kept()).toEqual([name]);
    const b = await person('b');
    const seen = b.watch(name);
    await until(() => seen.status() === 'shown', 5_000, 'b to fetch the picture');
    expect(await b.bytes(name)).toEqual(bytes);
    expect(b.images()).toHaveLength(1);
  });

  it('are not said to be kept on this device before it has kept one still to be sent, nor when it could not', async () => {
    const net = network();
    net.set('a', 'PUT', 'hold');
    const a = await person('a');
    let release!: () => void;
    a.pictures.hold = new Promise<void>((go) => (release = go));
    const placing = a.insert(picture('書き込み中').dataUrl);
    await until(() => a.s().collab?.pending === 1, 5_000, 'the picture to be on its way to the device');
    expect(a.s().collab?.device).toBe('saving');
    release();
    await placing;
    await until(() => a.s().collab?.device === 'saved', 5_000, 'the picture to be kept on the device');

    a.pictures.failing = new DOMException('full', 'QuotaExceededError');
    await a.insert(picture('入らない').dataUrl);
    await until(() => a.s().saving === 'error', 5_000, 'the picture to be found not kept');
    expect(a.s().collab?.unkept).toBe(true);
    expect(a.s().saveError).toMatch(/画像.*空き容量/);
    expect(a.images()).toHaveLength(2);
    net.set('a', 'PUT', undefined);
    net.release();
    await a.stored();
  });

  it('let the board be edited while a picture cannot be fetched, and show it once it can', async () => {
    const net = network();
    const a = await person('a');
    const placed = await a.insert(picture('取れない').dataUrl);
    await a.stored();
    net.set('b', 'GET', 'cut');
    const b = await person('b');
    const name = sharedName(srcOf(placed))!;
    const seen = b.watch(name);
    await until(() => seen.status() === 'unreachable', 5_000, 'the fetch to fail');
    b.s().checkpoint();
    b.s().updateNode(seed.shape.id, { x: 120, y: 80 }, false);
    b.s().commitOperation();
    await b.stored();
    await until(() => a.s().doc.nodes.find((n) => n.id === seed.shape.id)?.x === 120, 5_000, "b's move to reach a");
    net.set('b', 'GET', undefined);
    await until(() => seen.status() === 'shown', 15_000, 'b to fetch the picture once it can');
  });

  it('turn away a picture larger than the server keeps before it is put on the board, and tell one the server turned away from one that cannot be fetched', async () => {
    const a = await person('a');
    const big = `data:image/png;base64,${Buffer.alloc(MAX_PICTURE_BYTES + 1).toString('base64')}`;
    await expect(a.session.storeImage(big)).rejects.toThrow(/64MB/);
    const net = network();
    net.set('a', 'PUT', 403);
    const name = sharedName(srcOf(await a.insert(picture('断られる').dataUrl)))!;
    await until(() => a.watch(name).status() === 'refused', 5_000, 'the picture to be turned away');
    expect(kept()).toEqual([]);
  });

  it("are not taken from a viewer, nor kept inside the board", async () => {
    const v = await person('v', { credential: invite('viewer').token });
    expect(v.s().collab?.takes('images')).toBe(false);
    await expect(v.session.storeImage(picture('閲覧').dataUrl)).rejects.toThrow(/閲覧のみ/);
    expect(kept()).toEqual([]);

    // A picture kept inside the board (as a board of this machine keeps one) is turned away whole.
    const a = await person('a');
    a.s().mutate((d) => ({ ...d, nodes: [...d.nodes, makeImage(allIds(d), { src: picture('埋め込み').dataUrl, w: 40, h: 20, name: '図' }, 0, 0)] }));
    expect(a.images()).toEqual([]);
    expect(a.s().notice).toMatch(/まだこの編集はできません/);
  });

  it("go to the project under the name a board's folder keeps the same picture under, and come back as the same bytes", async () => {
    const { dataUrl, bytes } = picture('手元の画像');
    const local = await assetOf(dataUrl);
    const a = await person('a');
    const placed = await a.insert(dataUrl);
    expect(srcOf(placed)).toBe(`shared:${local!.name}`);
    await a.stored();
    const b = await person('b');
    expect(await b.bytes(local!.name)).toEqual(bytes);
  });
});
