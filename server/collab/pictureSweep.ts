import * as Y from 'yjs';
import { sharedName } from '../../src/collab/pictureRef';
import type { PictureStore } from './pictureStore';
import type { CollabStore } from './store';

/** How often the pictures are swept, unless the period they are kept for is shorter. */
const SWEEP_MS = 3_600_000;

/**
 * The names of the pictures a project refers to (`shared:<name>`, see src/collab/pictureRef.ts)
 * anywhere in its Yjs state: on a board, a deleted one that can be restored included. Read without
 * the form of the project (see src/collab/model.ts), so that a reference kept somewhere new counts.
 */
function usedPictures(state: Uint8Array): Set<string> {
  const used = new Set<string>();
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, state);
    // Not by recursion: an editor may nest what a project holds as deep as it likes.
    const left: unknown[] = [...ydoc.share.keys()].map((key) => ydoc.getMap(key));
    while (left.length) {
      const value = left.pop();
      if (typeof value === 'string') {
        const name = sharedName(value);
        if (name) used.add(name);
      } else if (value instanceof Y.Map || value instanceof Y.Array || Array.isArray(value)) {
        value.forEach((held: unknown) => left.push(held));
      } else if (value && typeof value === 'object' && !(value instanceof Y.AbstractType) && !ArrayBuffer.isView(value)) {
        for (const held of Object.values(value)) left.push(held);
      }
    }
  } finally {
    ydoc.destroy();
  }
  return used;
}

/**
 * The sweep of the pictures no board uses: one is taken off the server once it has been unused for
 * `keepMs`. Since when it is unused is not when its node was taken off but when a sweep first found
 * it so, kept in the store (it holds through a restart); found in use again, or put again, it is
 * unused anew from the sweep that next finds it so. Until then it stays, for the undo of whoever
 * took it off. The pictures of a deleted project stay as they are, for its restore, and are unused
 * anew from then (see restoreProject in store.ts).
 */
export function pictureSweep(store: CollabStore, pictures: PictureStore, keepMs: number) {
  // Unmarked as it is put, kept before or not: its node may reach the project only after it, and
  // it must not go meanwhile for having been unused before.
  pictures.onPut((project, name) => store.unmarkUnusedPictures(project, [name]));

  /**
   * Mark the pictures kept of a project as it uses them at `now`: those newly found unused are
   * marked, those in use again unmarked. Returns those unused for the whole period, unmarked to go.
   */
  function markUnused(project: string, names: string[], now: number): string[] {
    if (store.isDeleted(project)) return [];
    const marks = store.unusedPictures(project);
    const state = names.length ? store.load(project) : null;
    const used = state && usedPictures(state);
    const unused = used ? names.filter((name) => !used.has(name)) : [];
    const due = (name: string): boolean => now - (marks.get(name) ?? now) >= keepMs;
    const waiting = new Set(unused.filter((name) => !due(name)));
    const found = [...waiting].filter((name) => !marks.has(name));
    const settled = [...marks.keys()].filter((name) => !waiting.has(name));
    if (found.length) store.markUnusedPictures(project, found, now);
    if (settled.length) store.unmarkUnusedPictures(project, settled);
    return unused.filter(due);
  }

  /** Sweep the pictures of every project as `now` finds them. */
  async function run(now: number): Promise<void> {
    for (const project of await pictures.projects()) {
      try {
        for (const name of await pictures.takeOff(project, (names) => markUnused(project, names, now))) console.warn(`[keito-collab] ${project}: picture ${name} taken off (no board used it for the period)`);
      } catch (e) {
        console.error(`[keito-collab] ${project}: pictures not swept: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Each project is read in one go (see takeOff): what else the server has to do is done between two of them.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    run,

    /** Sweep now, and again every hour (every period, when that is shorter). Returns what stops it. */
    start(): () => void {
      let running = false;
      const sweep = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
          await run(Date.now());
        } catch (e) {
          console.error(`[keito-collab] pictures not swept: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          running = false;
        }
      };
      void sweep();
      const timer = setInterval(() => void sweep(), Math.min(SWEEP_MS, keepMs));
      return () => clearInterval(timer);
    },
  };
}

export type PictureSweep = ReturnType<typeof pictureSweep>;
