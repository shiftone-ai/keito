/**
 * Where the bytes of the shared projects' pictures are kept: the server's disk (see
 * diskPictures.ts), or anything else that keeps bytes under a project and a name. What keeps them,
 * and how, shows here alone: the rules of pictureStore, and whatever uses that, know only this.
 * It is given only projects of letters, digits, `_` and `-`, and names that are a picture's (see
 * src/collab/pictureRef.ts): it may make a path or a key of them as they are. A call that rejects
 * leaves it unsaid whether the picture is kept.
 */
export interface PictureEngine {
  /** Keep a picture, whole and lasting once this resolves: a crash leaves either the whole picture or none. */
  keep(project: string, name: string, bytes: Uint8Array): Promise<void>;
  /** A picture as kept; null for none of that name. */
  read(project: string, name: string): Promise<Uint8Array | null>;
  /** Take a picture off; nothing is done for none of that name. */
  takeOff(project: string, name: string): Promise<void>;
  /** The pictures kept of a project, each with its size in bytes. */
  list(project: string): Promise<Map<string, number>>;
  /** The projects a picture was ever kept of. */
  projects(): Promise<string[]>;
  /** How many more bytes it takes; null when it cannot tell. */
  room(): Promise<number | null>;
}

/** Why a picture is not kept: it would take its project's pictures over the limit, or what keeps the pictures has no room for it. */
export type NoRoom = 'project-full' | 'store-full';

/** The pictures kept of a project, each with its size, and what they take together. */
interface Kept {
  sizes: Map<string, number>;
  total: number;
}

/**
 * The pictures of the shared projects, and the rules they are kept by whatever keeps their bytes
 * (`engine`). A picture is kept once under its name (a hash of its bytes, see
 * src/collab/pictureRef.ts), only while its project's pictures stay within `perProject` bytes and
 * the engine has room for it, and until it is taken off. Nothing else changes what the engine keeps
 * while the server runs: what is kept of a project is listed once, and counted from then on (listed
 * anew after a call of the engine that failed). The caller gives it only the projects and names an
 * engine takes (see PictureEngine).
 */
export function pictureStore(engine: PictureEngine, limits: { perProject: number }) {
  const listed = new Map<string, Promise<Kept>>();
  /** What was asked last of those done in turn (see inTurn). */
  let last: Promise<unknown> = Promise.resolve();
  /** Who hears of each picture put (see onPut). */
  let hearPut = (_project: string, _name: string): void => {};

  /** Do `work` once what was asked before it is done: one at a time, in the order asked. */
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = last.then(work);
    last = turn.catch(() => {});
    return turn;
  }

  async function list(project: string): Promise<Kept> {
    const sizes = await engine.list(project);
    return { sizes, total: [...sizes.values()].reduce((sum, size) => sum + size, 0) };
  }

  /** The pictures kept of a project: listed the first time, and again after a listing that failed. */
  function keptOf(project: string): Promise<Kept> {
    let kept = listed.get(project);
    if (!kept) {
      kept = list(project);
      listed.set(project, kept);
      kept.catch(() => listed.delete(project));
    }
    return kept;
  }

  /** What the engine was asked to change of a project: should it fail, what it keeps of the project is listed anew. */
  async function sure(project: string, asked: Promise<void>): Promise<void> {
    try {
      await asked;
    } catch (e) {
      listed.delete(project);
      throw e;
    }
  }

  /** Keep a picture as put says, in its turn. */
  async function keep(project: string, name: string, bytes: Uint8Array): Promise<'stored' | 'known' | NoRoom> {
    const kept = await keptOf(project);
    if (kept.sizes.has(name)) return 'known';
    if (kept.total + bytes.length > limits.perProject) return 'project-full';
    const room = await engine.room();
    if (room !== null && bytes.length > room) return 'store-full';
    await sure(project, engine.keep(project, name, bytes));
    kept.sizes.set(name, bytes.length);
    kept.total += bytes.length;
    return 'stored';
  }

  return {
    /**
     * Keep a picture of a project until it is taken off: kept for good by the engine once this
     * resolves 'stored'; 'known', when it was kept before. Not kept when there is no room for it:
     * 'project-full' when it would take the project's pictures over `perProject`, 'store-full'
     * when the engine has no room for it.
     */
    async put(project: string, name: string, bytes: Uint8Array): Promise<'stored' | 'known' | NoRoom> {
      hearPut(project, name);
      // In turn, not as they come: pictures sent at once would each find the room another is about to take.
      return inTurn(() => keep(project, name, bytes));
    },

    /** A picture of a project as kept; null for none of that name. */
    get: (project: string, name: string): Promise<Uint8Array | null> => engine.read(project, name),

    /** Hear of each picture put, kept before or not: `hear` is called as put is, before anything is awaited. */
    onPut(hear: (project: string, name: string) => void): void {
      hearPut = hear;
    },

    /** The projects a picture was ever sent to. */
    projects: (): Promise<string[]> => engine.projects(),

    /**
     * Take off the pictures of a project that `pick` chooses among those kept; resolves to those
     * the engine has let go. `pick` is called in turn with the pictures put, once none is being
     * kept, and nothing is awaited from its call until the engine is asked to let the first one go:
     * what `pick` reads of the project still holds then. One of them put again is kept anew, after
     * it is let go. Rejects when the engine fails to let one go.
     */
    takeOff(project: string, pick: (names: string[]) => string[]): Promise<string[]> {
      return inTurn(async () => {
        const kept = await keptOf(project);
        const gone: string[] = [];
        for (const name of pick([...kept.sizes.keys()])) {
          await sure(project, engine.takeOff(project, name));
          kept.total -= kept.sizes.get(name) ?? 0;
          kept.sizes.delete(name);
          gone.push(name);
        }
        return gone;
      });
    },
  };
}

export type PictureStore = ReturnType<typeof pictureStore>;
