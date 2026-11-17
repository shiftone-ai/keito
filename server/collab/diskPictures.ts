import { randomUUID } from 'node:crypto';
import { type Dirent, mkdirSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { isPictureName } from '../../src/collab/pictureRef';
import { removeFile } from '../store';
import type { PictureEngine } from './pictureStore';

/**
 * The server's disk as the place the pictures' bytes are kept (see PictureEngine): a file per
 * picture, <folder>/<project>/<name>, beside the server's SQLite file. The caller gives it only
 * projects and names it may make a path of. Its room is what the disk the folder is on has free, to a
 * user who is not root, above `minFree` bytes: the SQLite file is written to the same disk.
 */
export function diskPictures(folder: string, options: { minFree: number }): PictureEngine {
  mkdirSync(folder, { recursive: true, mode: 0o700 });

  /** What a folder holds; nothing for no such folder. */
  async function entriesOf(dir: string): Promise<Dirent[]> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
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

  return {
    async keep(project, name, bytes) {
      const dir = join(folder, project);
      const made = await mkdir(dir, { recursive: true, mode: 0o700 });
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
    },

    async read(project, name) {
      try {
        return await readFile(join(folder, project, name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    async takeOff(project, name) {
      removeFile(join(folder, project, name));
    },

    async list(project) {
      const dir = join(folder, project);
      const sizes = new Map<string, number>();
      for (const { name } of (await entriesOf(dir)).filter((entry) => isPictureName(entry.name))) sizes.set(name, (await stat(join(dir, name))).size);
      return sizes;
    },

    async projects() {
      return (await entriesOf(folder)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },

    async room() {
      const disk = await statfs(folder);
      return Math.max(0, disk.bavail * disk.bsize - options.minFree);
    },
  };
}
