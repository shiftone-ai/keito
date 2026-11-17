import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { isPictureName } from '../../src/collab/pictureRef';
import { removeFile } from '../store';

/** How much of its disk the pictures may take, in bytes. */
export interface PictureLimits {
  /** The most the pictures of one project take together. */
  perProject: number;
  /** The free space a picture kept leaves on the disk the folder is on. */
  minFree: number;
}

/** Why a picture is not kept: it would take its project's pictures over the limit, or leave the disk too little free space. */
export type NoRoom = 'project-full' | 'disk-full';

/** The pictures kept of a project, each with its size, and what they take together. */
interface Kept {
  sizes: Map<string, number>;
  total: number;
}

/** The bytes free, to a user who is not root, on the disk `folder` is on. */
async function freeOn(folder: string): Promise<number> {
  const disk = await statfs(folder);
  return disk.bavail * disk.bsize;
}

/**
 * The pictures of the shared projects, kept on the server's disk beside its SQLite file:
 * <folder>/<project>/<name>, a file per picture, never written over once there (a name is a hash
 * of the bytes, see src/collab/pictureRef.ts). The caller checks that the project and the name are
 * ones it may make a path of. Nothing else writes the folder while the server runs: what is kept of
 * a project is read from it once, and counted from then on. `free` reads the disk's free space.
 */
export function pictureStore(folder: string, limits: PictureLimits, free: () => Promise<number> = () => freeOn(folder)) {
  const kept = new Map<string, Promise<Kept>>();
  /** The picture kept last, or being kept: the next waits for it (see put). */
  let last: Promise<unknown> = Promise.resolve();
  /** Who hears of each picture put (see onPut). */
  let hearPut = (_project: string, _name: string): void => {};

  /** What a folder holds; nothing for no such folder. */
  async function entriesOf(dir: string): Promise<Dirent[]> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** The pictures in a project's folder. */
  async function read(project: string): Promise<Kept> {
    const room: Kept = { sizes: new Map(), total: 0 };
    const dir = join(folder, project);
    for (const { name } of (await entriesOf(dir)).filter((entry) => isPictureName(entry.name))) {
      const { size } = await stat(join(dir, name));
      room.sizes.set(name, size);
      room.total += size;
    }
    return room;
  }

  /** The pictures kept of a project: read from its folder the first time, and again after a read that failed. */
  function keptOf(project: string): Promise<Kept> {
    let room = kept.get(project);
    if (!room) {
      room = read(project);
      kept.set(project, room);
      room.catch(() => kept.delete(project));
    }
    return room;
  }

  // Without it, a file renamed into place may be lost with a power cut after the server answered.
  async function syncFolder(dir: string): Promise<void> {
    // Windows opens no folder to sync: there the rename is what the disk keeps.
    if (process.platform === 'win32') return;
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Keep a picture as put says, while no other is being kept. */
  async function keep(project: string, name: string, bytes: Uint8Array): Promise<'stored' | 'known' | NoRoom> {
    const room = await keptOf(project);
    if (room.sizes.has(name)) return 'known';
    if (room.total + bytes.length > limits.perProject) return 'project-full';
    const dir = join(folder, project);
    const made = await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await free()) - bytes.length < limits.minFree) return 'disk-full';
    const part = join(dir, `.${name}.${randomUUID()}.part`);
    try {
      const handle = await open(part, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(part, join(dir, name));
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
    await syncFolder(dir);
    if (made) await syncFolder(folder);
    room.sizes.set(name, bytes.length);
    room.total += bytes.length;
    return 'stored';
  }

  return {
    /**
     * Keep a picture of a project until it is taken off: on the disk (not only in the system's
     * cache) once this resolves 'stored'; 'known', when it was kept before. Never half written: a
     * crash leaves either the whole picture or none. Not kept when there is no room for it:
     * 'project-full' when it would take the project's pictures over `perProject`, 'disk-full' when
     * it would leave the disk less than `minFree`.
     */
    async put(project: string, name: string, bytes: Uint8Array): Promise<'stored' | 'known' | NoRoom> {
      hearPut(project, name);
      // One at a time, not as they come: pictures sent at once would each find the room another is about to take.
      const turn = last.then(() => keep(project, name, bytes));
      last = turn.catch(() => {});
      return turn;
    },

    /** A picture of a project as kept; null for none of that name. */
    async get(project: string, name: string): Promise<Uint8Array | null> {
      try {
        return await readFile(join(folder, project, name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    /** Hear of each picture put, kept before or not: `hear` is called as put is, before anything is awaited. */
    onPut(hear: (project: string, name: string) => void): void {
      hearPut = hear;
    },

    /** The projects a picture was ever sent to. */
    async projects(): Promise<string[]> {
      return (await entriesOf(folder)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },

    /**
     * Take off the pictures of a project that `pick` chooses among those kept; resolves to them.
     * Nothing is awaited from the call of `pick` to the last one taken off: what `pick` reads of the
     * project still holds when they go, and no picture is put in between.
     */
    async takeOff(project: string, pick: (names: string[]) => string[]): Promise<string[]> {
      const room = await keptOf(project);
      const picked = pick([...room.sizes.keys()]);
      for (const name of picked) {
        removeFile(join(folder, project, name));
        room.total -= room.sizes.get(name) ?? 0;
        room.sizes.delete(name);
      }
      return picked;
    },
  };
}

export type PictureStore = ReturnType<typeof pictureStore>;
