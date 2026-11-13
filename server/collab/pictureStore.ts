import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pictures of the shared projects, kept on the server's disk beside its SQLite file:
 * <folder>/<project>/<name>, a file per picture, never written over once there (a name is a hash
 * of the bytes, see src/collab/pictureRef.ts). The caller checks that the project and the name are
 * ones it may make a path of.
 */
export function pictureStore(folder: string) {
  const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

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
    /**
     * Keep a picture of a project for good: on the disk (not only in the system's cache) once this
     * resolves 'stored'; 'known', when it was kept before. Never half written: a crash leaves either
     * the whole picture or none.
     */
    async put(project: string, name: string, bytes: Uint8Array): Promise<'stored' | 'known'> {
      const dir = join(folder, project);
      const file = join(dir, name);
      if (await exists(file)) return 'known';
      const made = !(await exists(dir));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const part = join(dir, `.${name}.${randomUUID()}.part`);
      try {
        const handle = await open(part, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(part, file);
      } catch (e) {
        await rm(part, { force: true });
        throw e;
      }
      await syncFolder(dir);
      if (made) await syncFolder(folder);
      return 'stored';
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
  };
}

export type PictureStore = ReturnType<typeof pictureStore>;
