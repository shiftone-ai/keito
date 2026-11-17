import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PictureEngine } from '../server/collab/pictureStore';

/** The bytes of a picture of its own (an SVG). */
export const picture = (text: string): Uint8Array => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text y="15">${text}</text></svg>`);

/** The name a picture's bytes are kept under (see src/collab/pictureRef.ts). */
export const nameOf = (bytes: Uint8Array): string => `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.svg`;

/**
 * A place for the pictures' bytes that is no disk: they are held in memory, as a browser holds
 * IndexedDB. `capacity`: how many bytes it takes in all (null: it cannot tell how many more).
 */
export function memoryEngine(capacity: number | null = null): PictureEngine {
  const kept = new Map<string, Map<string, Uint8Array>>();
  const held = (): number => [...kept.values()].flatMap((pictures) => [...pictures.values()]).reduce((sum, bytes) => sum + bytes.length, 0);
  return {
    async keep(project, name, bytes) {
      if (!kept.has(project)) kept.set(project, new Map());
      kept.get(project)!.set(name, bytes);
    },
    read: async (project, name) => kept.get(project)?.get(name) ?? null,
    async takeOff(project, name) {
      kept.get(project)?.delete(name);
    },
    list: async (project) => new Map([...(kept.get(project) ?? [])].map(([name, bytes]) => [name, bytes.length])),
    projects: async () => [...kept.keys()],
    room: async () => (capacity === null ? null : capacity - held()),
  };
}

/**
 * What every place the pictures' bytes are kept must do (see PictureEngine), whatever it keeps them
 * on: the rules of pictureStore rely on no more than this. `make` gives a new one, keeping nothing.
 * An engine added later proves itself by the same tests.
 */
export function everyEngine(what: string, make: () => PictureEngine): void {
  /** A picture as the engine gives it back, as plain bytes; null for none. */
  const read = async (engine: PictureEngine, project: string, name: string): Promise<Uint8Array | null> => {
    const bytes = await engine.read(project, name);
    return bytes && new Uint8Array(bytes);
  };

  describe(`${what}, as any place pictures are kept`, () => {
    it('gives back the bytes it was given to keep, and lists them with their sizes, each project apart', async () => {
      const [one, two] = [picture('一枚目'), picture('二枚目のほうが長い')];
      const engine = make();
      await engine.keep('a', nameOf(one), one);
      await engine.keep('a', nameOf(two), two);
      await engine.keep('b', nameOf(one), one);
      expect(await read(engine, 'a', nameOf(one))).toEqual(one);
      expect(await read(engine, 'a', nameOf(two))).toEqual(two);
      expect(await engine.list('a')).toEqual(new Map([[nameOf(one), one.length], [nameOf(two), two.length]]));
      expect(await engine.list('b')).toEqual(new Map([[nameOf(one), one.length]]));
      expect(await read(engine, 'b', nameOf(two))).toBeNull();
      expect((await engine.projects()).sort()).toEqual(['a', 'b']);
    });

    it('keeps a picture given twice once', async () => {
      const one = picture('二度送った画像');
      const engine = make();
      await engine.keep('a', nameOf(one), one);
      await engine.keep('a', nameOf(one), one);
      expect(await engine.list('a')).toEqual(new Map([[nameOf(one), one.length]]));
      expect(await read(engine, 'a', nameOf(one))).toEqual(one);
    });

    it('has nothing of a project or a name it was never given, and takes off what is not there without failing', async () => {
      const one = picture('一枚目');
      const engine = make();
      expect(await engine.read('never', nameOf(one))).toBeNull();
      expect(await engine.list('never')).toEqual(new Map());
      expect(await engine.projects()).toEqual([]);
      await engine.takeOff('never', nameOf(one));
      await engine.keep('a', nameOf(one), one);
      expect(await engine.read('a', nameOf(picture('別の画像')))).toBeNull();
      expect(await engine.projects()).toEqual(['a']);
    });

    it('no longer has a picture it took off, and keeps the others', async () => {
      const [one, two] = [picture('一枚目'), picture('二枚目')];
      const engine = make();
      await engine.keep('a', nameOf(one), one);
      await engine.keep('a', nameOf(two), two);
      await engine.takeOff('a', nameOf(one));
      await engine.takeOff('a', nameOf(one));
      expect(await engine.read('a', nameOf(one))).toBeNull();
      expect(await engine.list('a')).toEqual(new Map([[nameOf(two), two.length]]));
      expect(await read(engine, 'a', nameOf(two))).toEqual(two);
    });

    it('says how many more bytes it takes, or that it cannot tell', async () => {
      const room = await make().room();
      expect(room === null || room >= 0).toBe(true);
    });
  });
}
