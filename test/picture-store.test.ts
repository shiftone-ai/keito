import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { diskPictures } from '../server/collab/diskPictures';
import { type PictureEngine, type PictureStore, pictureStore } from '../server/collab/pictureStore';
import { type PictureSweep, pictureSweep } from '../server/collab/pictureSweep';
import { type CollabStore, openStore } from '../server/collab/store';
import { addBoard, boardNodes, deleteBoard } from '../src/collab/boards';
import type { ProjectSeed } from '../src/collab/model';
import { sharedSrc } from '../src/collab/pictureRef';
import { seedData } from './collab';
import { everyEngine, memoryEngine, nameOf, picture } from './pictureEngine';

/** The folders the disk was given in a test, taken away after it. */
const folders: string[] = [];
function folder(): string {
  folders.push(mkdtempSync(join(tmpdir(), 'keito-pictures-')));
  return folders.at(-1)!;
}
afterEach(() => folders.splice(0).forEach((made) => rmSync(made, { recursive: true, force: true })));

everyEngine('memory', () => memoryEngine());
everyEngine('the disk', () => diskPictures(folder(), { minFree: 0 }));

describe('the pictures a store keeps, whatever keeps their bytes', () => {
  it("keeps a picture once, and turns away one that would take its project's pictures over the limit", async () => {
    const [one, two] = [picture('一枚目'), picture('二枚目')];
    const engine = memoryEngine();
    const pictures = pictureStore(engine, { perProject: one.length + two.length - 1 });
    expect((await Promise.all([pictures.put('a', nameOf(one), one), pictures.put('a', nameOf(one), one)])).sort()).toEqual(['known', 'stored']);
    expect(await pictures.put('a', nameOf(two), two)).toBe('project-full');
    expect(await pictures.get('a', nameOf(one))).toEqual(one);
    expect(await pictures.get('a', nameOf(two))).toBeNull();
    // Another project has its own room.
    expect(await pictures.put('b', nameOf(two), two)).toBe('stored');
    expect([...(await engine.list('a')).keys()]).toEqual([nameOf(one)]);
  });

  it("keeps the pictures sent at once within the project's limit, and within the room their engine has, together", async () => {
    const sent = Array.from({ length: 6 }, (_, i) => picture(`同時 ${i}`));
    const at = (pictures: PictureStore) => Promise.all(sent.map((bytes) => pictures.put('a', nameOf(bytes), bytes)));
    // Room for two of them, not three: by the project's limit, then by what the engine takes.
    expect((await at(pictureStore(memoryEngine(), { perProject: sent[0].length * 3 - 1 }))).sort()).toEqual(['project-full', 'project-full', 'project-full', 'project-full', 'stored', 'stored']);
    expect((await at(pictureStore(memoryEngine(sent[0].length * 3 - 1), { perProject: Infinity }))).sort()).toEqual(['store-full', 'store-full', 'store-full', 'store-full', 'stored', 'stored']);
    // An engine that cannot tell its room takes them all.
    expect(new Set(await at(pictureStore(memoryEngine(), { perProject: Infinity })))).toEqual(new Set(['stored']));
  });

  it('picks what to take off only once the pictures sent before are kept, among those kept by then', async () => {
    const one = picture('保存の途中の画像');
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const quick = memoryEngine();
    // An engine that takes its time to keep a picture, as a disk or a network does.
    const pictures = pictureStore({ ...quick, keep: (project, name, bytes) => held.then(() => quick.keep(project, name, bytes)) }, { perProject: Infinity });
    const sent = pictures.put('a', nameOf(one), one);
    let picked = false;
    const taken = pictures.takeOff('a', (names) => {
      picked = true;
      return names;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(picked).toBe(false);
    letGo();
    expect(await sent).toBe('stored');
    expect(await taken).toEqual([nameOf(one)]);
    expect(await pictures.get('a', nameOf(one))).toBeNull();
  });
});

describe('the pictures no board uses', () => {
  const DAY = 86_400_000;
  const PERIOD = 30 * DAY;
  /** When the first sweep runs: the time is given to each one. */
  const T0 = Date.UTC(2026, 0, 1);
  let data: string;
  let seed: ProjectSeed;
  let engine: PictureEngine;
  let store: CollabStore;
  let pictures: PictureStore;
  let sweep: PictureSweep;

  /** The server's own parts over what it keeps (the SQLite file, the pictures' bytes), as `serve` puts them together, started anew. */
  function start(perProject = Infinity): void {
    store = openStore(join(data, 'keito-collab.sqlite'));
    pictures = pictureStore(engine, { perProject });
    sweep = pictureSweep(store, pictures, PERIOD);
  }

  beforeEach(() => {
    ({ data, seed } = seedData());
    engine = memoryEngine();
    start();
  });
  afterEach(() => {
    store.close();
    rmSync(data, { recursive: true, force: true });
  });

  /** The names of the pictures kept of the project. */
  const kept = async (): Promise<string[]> => [...(await engine.list(seed.id)).keys()].sort();
  /** Change the project as an editor's commit does. */
  function edit(change: (ydoc: Y.Doc) => void): void {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, store.load(seed.id)!);
    const before = Y.encodeStateVector(ydoc);
    change(ydoc);
    store.commit(seed.id, randomUUID(), Y.encodeStateAsUpdate(ydoc, before));
  }
  /** Put a picture on a board, as an image node refers to it; returns what takes it off again. */
  function place(name: string, board = seed.board.id): () => void {
    const id = randomUUID();
    edit((ydoc) => {
      const node = new Y.Map<unknown>();
      boardNodes(ydoc, board)!.set(id, node);
      node.set('src', sharedSrc(name));
    });
    return () => edit((ydoc) => boardNodes(ydoc, board)!.delete(id));
  }
  /** Send a picture of its own to the project. */
  async function send(text: string): Promise<string> {
    const bytes = picture(text);
    expect(await pictures.put(seed.id, nameOf(bytes), bytes)).toBe('stored');
    return nameOf(bytes);
  }

  it('are taken off once no board has used them for the whole period, making room, while those a board uses stay, a deleted board that can be restored included', async () => {
    const texts = ['使っている画像', '削除したボードの画像', '消した画像', '置かなかった画像'];
    store.close();
    start(texts.reduce((sum, text) => sum + picture(text).length, 0));
    const [used, deleted, removed, never] = [await send(texts[0]), await send(texts[1]), await send(texts[2]), await send(texts[3])];
    place(used);
    let other = '';
    edit((ydoc) => void (other = addBoard(ydoc, { title: '控え', kind: 'free' }, null)));
    place(deleted, other);
    edit((ydoc) => deleteBoard(ydoc, other, null));
    place(removed)();
    const more = picture('入らない画像');
    expect(await pictures.put(seed.id, nameOf(more), more)).toBe('project-full');

    await sweep.run(T0);
    await sweep.run(T0 + PERIOD - 1);
    expect(await kept()).toEqual([used, deleted, removed, never].sort());
    await sweep.run(T0 + PERIOD);
    expect(await kept()).toEqual([used, deleted].sort());
    expect(await pictures.get(seed.id, removed)).toBeNull();
    expect(await pictures.put(seed.id, nameOf(more), more)).toBe('stored');
  });

  it('stay a whole period more when they are brought back to a board, or sent again, within the period', async () => {
    const [undone, resent] = [await send('元に戻した画像'), await send('送り直した画像')];
    const takeOff = place(undone);
    takeOff();
    await sweep.run(T0);
    // Undone a day before it would go, and taken off for good ten days later.
    const again = place(undone);
    expect(await pictures.put(seed.id, resent, picture('送り直した画像'))).toBe('known');
    await sweep.run(T0 + PERIOD - DAY);
    again();
    await sweep.run(T0 + PERIOD + 9 * DAY);
    expect(await kept()).toEqual([undone, resent].sort());
    await sweep.run(T0 + 2 * PERIOD - DAY);
    expect(await kept()).toEqual([undone]);
    await sweep.run(T0 + 2 * PERIOD + 9 * DAY);
    expect(await kept()).toEqual([]);
  });

  it('are kept anew when they are sent while their engine is still taking them off', async () => {
    let asked!: () => void;
    let letGo!: () => void;
    const taking = new Promise<void>((resolve) => (asked = resolve));
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const slow = engine;
    // An engine that takes its time to take a picture off, as one over a network does.
    engine = {
      ...slow,
      async takeOff(project, name) {
        asked();
        await held;
        await slow.takeOff(project, name);
      },
    };
    store.close();
    start();
    const bytes = picture('置き直した画像');
    const name = await send('置き直した画像');
    await sweep.run(T0);
    const sweeping = sweep.run(T0 + PERIOD);
    await taking;
    const again = pictures.put(seed.id, name, bytes);
    // As far as the put gets while the engine has not let the picture go.
    await new Promise((resolve) => setImmediate(resolve));
    letGo();
    await sweeping;
    expect(await again).toBe('stored');
    expect(await kept()).toEqual([name]);
  });

  it('are left alone when their project is deleted while the sweep waits for a picture being kept', async () => {
    const name = await send('削除の直前の画像');
    await sweep.run(T0);
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const quick = engine;
    // An engine that takes its time to keep a picture, as a disk or a network does.
    engine = { ...quick, keep: (project, picture, bytes) => held.then(() => quick.keep(project, picture, bytes)) };
    store.close();
    start();
    const other = picture('保存の途中の画像');
    const sent = pictures.put(seed.id, nameOf(other), other);
    const sweeping = sweep.run(T0 + PERIOD);
    await new Promise((resolve) => setImmediate(resolve));
    store.deleteProject(seed.id);
    letGo();
    await Promise.all([sent, sweeping]);
    expect(await kept()).toEqual([name, nameOf(other)].sort());
  });

  it('still count, and go a period later, when their engine fails to take them off', async () => {
    let failing = true;
    const sound = engine;
    engine = {
      ...sound,
      async takeOff(project, name) {
        if (failing) throw new Error('unreachable');
        await sound.takeOff(project, name);
      },
    };
    const [bytes, more] = [picture('消せなかった画像'), picture('入らない画像')];
    store.close();
    start(bytes.length);
    const name = await send('消せなかった画像');
    await sweep.run(T0);
    await sweep.run(T0 + PERIOD);
    expect(await kept()).toEqual([name]);
    expect(await pictures.put(seed.id, nameOf(more), more)).toBe('project-full');
    failing = false;
    await sweep.run(T0 + PERIOD + DAY);
    await sweep.run(T0 + 2 * PERIOD);
    expect(await kept()).toEqual([name]);
    await sweep.run(T0 + 2 * PERIOD + DAY);
    expect(await kept()).toEqual([]);
  });

  it('are kept anew when they are sent after their engine let them go and failed to say so', async () => {
    const sound = engine;
    // An engine whose answer is lost on the way back, as one over a network may be.
    engine = {
      ...sound,
      async takeOff(project, name) {
        await sound.takeOff(project, name);
        throw new Error('the answer was lost');
      },
    };
    store.close();
    start();
    const bytes = picture('返事のなかった画像');
    const name = await send('返事のなかった画像');
    await sweep.run(T0);
    await sweep.run(T0 + PERIOD);
    expect(await kept()).toEqual([]);
    expect(await pictures.put(seed.id, name, bytes)).toBe('stored');
    expect(await kept()).toEqual([name]);
  });

  it('are known to be unused since when through a restart of the server', async () => {
    const name = await send('再起動');
    await sweep.run(T0);
    store.close();
    start();
    await sweep.run(T0 + PERIOD - 1);
    expect(await kept()).toEqual([name]);
    await sweep.run(T0 + PERIOD);
    expect(await kept()).toEqual([]);
  });

  it('are left alone in a deleted project, and stay a whole period more once it is restored', async () => {
    const name = await send('削除した案件');
    await sweep.run(T0);
    store.deleteProject(seed.id);
    await sweep.run(T0 + PERIOD);
    expect(await kept()).toEqual([name]);
    store.restoreProject(seed.id);
    await sweep.run(T0 + PERIOD + DAY);
    // Deleted and restored again with no sweep in between, as while the server is stopped.
    store.deleteProject(seed.id);
    store.restoreProject(seed.id);
    await sweep.run(T0 + 2 * PERIOD + DAY);
    expect(await kept()).toEqual([name]);
    await sweep.run(T0 + 3 * PERIOD + DAY);
    expect(await kept()).toEqual([]);
  });
});

describe('the disk as the place pictures are kept', () => {
  it('still has a picture when it is started anew over the same folder, and takes what a crash left of one for no picture', async () => {
    const [one, two] = [picture('一枚目'), picture('二枚目のほうが長い')];
    const kept = folder();
    const disk = diskPictures(kept, { minFree: 0 });
    await disk.keep('a', nameOf(one), one);
    await disk.keep('a', nameOf(two), two);
    // Nothing but the pictures: what one was written through is gone.
    expect(readdirSync(join(kept, 'a')).sort()).toEqual([nameOf(one), nameOf(two)].sort());
    writeFileSync(join(kept, 'a', `.${nameOf(one)}.left.part`), 'half');

    const again = diskPictures(kept, { minFree: 0 });
    expect(new Uint8Array((await again.read('a', nameOf(two)))!)).toEqual(two);
    expect(await again.list('a')).toEqual(new Map([[nameOf(one), one.length], [nameOf(two), two.length]]));
    expect(await again.projects()).toEqual(['a']);
  });

  it('has for room what its disk has free above what it is told to leave free', async () => {
    expect(await diskPictures(folder(), { minFree: 0 }).room()).toBeGreaterThan(0);
    // More than any disk has free.
    expect(await diskPictures(folder(), { minFree: 8000 * 1024 ** 4 }).room()).toBe(0);
  });
});
