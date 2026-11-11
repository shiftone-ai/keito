import { ask, tell } from '../platform/io';
import { type Backend, type BoardInfo, Conflict, Gone } from '../platform/storage';
import type { State } from './store';
import type { Saving } from './target';
import type { Doc } from './types';

/** What the saving of a board of this machine's store needs of the edit session. */
export interface SavingHost {
  get(): State;
  set(change: Partial<State> | ((s: State) => Partial<State>)): void;
  /** The store, once connected. */
  backend(): Backend | null;
  /** Whether the session still runs. */
  active(): boolean;
  /** A check that stays true while the board on screen is the one it was taken for (the session's scope). */
  scope(): () => boolean;
  say(text: string): void;
  /**
   * What goes out before a flush writes the board itself: the state it was opened in into its
   * history, and the shared things edited here to the project's other boards.
   */
  beforeFlush(): Promise<void>;
  /** What is done before the board is left: its state kept in its history. */
  beforeLeave(): Promise<void>;
}

/** The saving of a board of this machine's store, and what the rest of the session tells it. */
export interface LocalSaving extends Saving {
  /** Write `doc` once the writes sent before it are answered. */
  persist(doc: Doc): Promise<void>;
  /**
   * The board was written or deleted elsewhere since it was read here: nothing more goes out until the
   * user settles it (see resolveConflict), not even a save already waiting to fire.
   */
  enterConflict(kind: 'conflict' | 'gone'): void;
  /** Autosave shortly after every change. */
  autosave(s: State, prev: State): void;
  /** The board as the store holds it, as last read from or written to it. */
  stored(): Doc | null;
  /** The store holds `doc` now (read from it, or written over it by the user's choice). */
  setStored(doc: Doc): void;
  /** A board put on screen as the store holds it: nothing of the board before is written or tried again. */
  reset(doc: Doc): void;
  /** The write waiting for the board on screen goes nowhere (the board is being deleted). */
  cancel(): void;
  stop(): void;
}

const RETRY_MS = [2_000, 5_000, 10_000, 30_000];

/**
 * Writing a board of this machine's store: shortly after each edit, one write at a time, tried again
 * after a failure, and held once the board was written or deleted elsewhere until the user settles
 * it (see resolveConflict).
 */
export function localSaving(host: SavingHost): LocalSaving {
  /** The doc as last read from or written to storage; equal to the current doc means nothing to save. */
  let stored: Doc | null = null;
  let timer: number | undefined;
  /**
   * Writes go out one after another. Two at once would both be made on the same version of the
   * board, and the second be refused as if the board had been changed elsewhere.
   */
  let writing: Promise<void> = Promise.resolve();
  /** Writes sent and not yet answered. */
  let inFlight = 0;
  let retryTimer = 0;
  let retries = 0;

  function persist(doc: Doc): Promise<void> {
    const b = host.backend();
    const current = host.scope();
    inFlight++;
    const next = writing.then(() => b && current() ? write(b, doc, current) : undefined).finally(() => inFlight--);
    writing = next.catch(() => {});
    return next;
  }

  /**
   * A write that failed for no lasting reason (the folder busy with another writer, the dev server
   * restarting, a moment offline) is tried again a little later, longer each time, until one goes
   * through. Refusals the user has to settle (conflict, gone) are left to them.
   */
  function retryLater(): void {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      const s = host.get();
      if (s.saving === 'error' && s.ready && !s.viewing && s.doc !== stored) void persist(s.doc);
    }, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
  }

  function enterConflict(kind: 'conflict' | 'gone'): void {
    clearTimeout(timer);
    host.set({ saving: kind });
  }

  async function write(b: Backend, doc: Doc, current: () => boolean): Promise<void> {
    if (!current()) return;
    // A write already sent may finish after its board is closed; its result belongs to that board.
    const here = () => current() && host.get().doc.id === doc.id;
    // Once the board is in conflict, only the user's choice writes it (a save queued before goes nowhere).
    const held = host.get().saving;
    if (here() && (held === 'conflict' || held === 'gone')) return;
    if (here()) host.set({ saving: 'saving' });
    try {
      await b.save(doc);
      if (!host.active()) return;
      const info: BoardInfo = { id: doc.id, title: doc.meta.title, updated: Date.now(), project: doc.meta.project || undefined, kind: doc.kind };
      host.set((s) => ({ boards: [info, ...s.boards.filter((x) => x.id !== doc.id)] }));
      if (!current()) return;
      stored = doc;
      retries = 0;
      clearTimeout(retryTimer);
      if (here()) host.set((s) => ({ saving: s.doc === doc ? 'saved' : 'saving', saveError: null }));
    } catch (e) {
      if (!here()) return console.error(e);
      // Written or deleted elsewhere since it was read here: the user settles it (see resolveConflict).
      if (e instanceof Conflict) return void enterConflict('conflict');
      if (e instanceof Gone) return void enterConflict('gone');
      console.error(e);
      host.set({ saving: 'error', saveError: e instanceof Error ? e.message : String(e) });
      retryLater();
    }
  }

  async function saveNow(): Promise<void> {
    const current = host.scope();
    clearTimeout(retryTimer);
    retries = 0;
    const s = host.get();
    const pending = s.doc !== stored;
    if (s.saving === 'error' && s.ready && !s.viewing && pending) await persist(s.doc).catch(() => {});
    else await flush();
    if (current() && host.get().saving === 'saved') host.say(pending ? '保存しました' : '保存済みです（変更は自動で保存されます）');
  }

  async function flush(): Promise<boolean> {
    const current = host.scope();
    clearTimeout(timer);
    await host.beforeFlush();
    if (!current()) return false;
    clearTimeout(timer);
    const { doc, ready, viewing, saving } = host.get();
    // An old revision on screen is never written over the live board, nor a conflict settled unasked.
    if (ready && !viewing && saving !== 'conflict' && saving !== 'gone' && doc !== stored) await persist(doc);
    else await writing;
    if (!current()) return false;
    const s = host.get();
    return !!s.viewing || !s.ready || (s.doc === stored && s.saving !== 'conflict' && s.saving !== 'gone' && s.saving !== 'error');
  }

  /**
   * Its state kept in its history, the board on screen may be left once its changes are written, or
   * the user lets go of those that cannot be (changed or deleted elsewhere, or the store unreachable).
   */
  async function leave(): Promise<boolean> {
    const current = host.scope();
    await host.beforeLeave();
    if (!current()) return false;
    if (await flush()) return true;
    if (!current()) return false;
    const saving = host.get().saving;
    if (saving === 'conflict') {
      await tell('このボードはほかの場所で更新されています。先に上の「読み込む」か「この画面で上書き」を選んでください。');
      return false;
    }
    const why = saving === 'gone' ? 'このボードはほかの場所で削除されています。' : 'このボードの変更を保存できていません。';
    return ask(`${why}\n保存されていない変更を捨てて、切り替えますか？`);
  }

  const unsaved = (): Doc | null => {
    const { doc, ready, viewing } = host.get();
    return ready && !viewing && doc !== stored ? doc : null;
  };

  /**
   * Closing within the autosave delay: what the store can take as the page goes is written then (see
   * exit); a board it cannot, or changes that cannot be written at all (changed or deleted
   * elsewhere, a failed write), make the browser ask before they are lost.
   */
  function closing(): boolean {
    const doc = unsaved();
    const b = host.backend();
    if (!doc || !b) return false;
    const stuck = ['conflict', 'gone', 'error'].includes(host.get().saving);
    // A write still under way: the one sent on leaving would be made on the version before it and be
    // refused, the last edits lost. The page asks, and finishes writing meanwhile.
    if (!stuck && !inFlight && b.fitsExitSave(doc)) return false;
    if (!stuck) void flush();
    return true;
  }

  function exit(): void {
    const doc = unsaved();
    const b = host.backend();
    if (!doc || !b || ['conflict', 'gone'].includes(host.get().saving)) return;
    b.exitSave(doc);
  }

  function autosave(s: State, prev: State): void {
    if (!s.ready || s.viewing || s.doc === prev.doc || s.doc === stored || s.saving === 'conflict' || s.saving === 'gone') return;
    clearTimeout(timer);
    if (s.saving !== 'saving') host.set({ saving: 'saving' });
    timer = window.setTimeout(() => void persist(host.get().doc), 500);
  }

  function stop(): void {
    clearTimeout(timer);
    clearTimeout(retryTimer);
  }

  return {
    persist,
    enterConflict,
    saveNow,
    flush,
    leave,
    closing,
    exit,
    autosave,
    failed(): void {
      if (host.get().doc !== stored) host.set({ saving: 'error' });
    },
    stored: () => stored,
    setStored(doc) {
      stored = doc;
    },
    reset(doc) {
      stored = doc;
      retries = 0;
      stop();
    },
    cancel(): void {
      clearTimeout(timer);
    },
    stop,
  };
}
