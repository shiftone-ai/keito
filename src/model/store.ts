import type { ShareStatus, SharedJoin, Steps } from '../collab/client';
import type { SharedBoardInfo } from '../collab/boards';
import type { DeviceStore } from '../collab/kept';
import type { EditKind } from '../collab/scope';
import type { BoardManagement } from '../collab/tabs';
import { sharedTarget } from '../collab/target';
import { localEdits } from './edits';
import { fitLegends } from './legend';
import { drawingOf, entryFor, fingerprint, sameBoard, thin } from './history';
import { localSaving } from './saving';
import type { StoreAction, Target } from './target';
import { create } from 'zustand';
import { type Backend, type BoardInfo, Conflict, type TrashedBoard, connect, externalize, localBoards } from '../platform/storage';
import { shortcuts, tell } from '../platform/io';
import { browserDevice } from '../platform/indexeddb';
import { type BoardKind, KINDS, kindOf } from './kinds';
import { SEQUENCE_SAMPLE } from './sequence';
import { BOARD_ID, readBoard } from './load';
import { docBounds, nodeRect, snap } from './geometry';
import { allIds, freshId, prefixOf, randomId } from './ids';
import { makeNode } from './presets';
import { sampleBoards } from './sample';
import { registerSignals } from './signals';
import { type Entry, type ShareNode, catalog, newKey, pull, stamp, takeFrom } from './shared';
import { type Doc, type Edge, type Node, type Rect, type Revision, type UserPreset, emptyMeta } from './types';

/** A board of this machine takes every edit. */
const takesAll = (): boolean => true;

export type Tool = 'select' | 'pan' | 'rect' | 'round' | 'diamond' | 'ellipse' | 'cloud' | 'sticky' | 'text' | 'frame' | 'sequence';
/** A window over the board (one at a time). */
export type Panel = null | 'export' | 'boards' | 'settings';
/** Panels beside the board, open alongside one another: the library, the lists, the comments. */
export type Dock = 'library' | 'lists' | 'comments';
/**
 * Something picked from the toolbar or a library, waiting to be put where the user clicks (its
 * outline follows the pointer). `place` puts it centred on a point of the board.
 */
export interface Placing {
  label: string;
  size: { w: number; h: number };
  place(at: { x: number; y: number }): void;
}

export interface View {
  x: number;
  y: number;
  k: number;
}

/** A board's state goes into its history once editing has paused this long. */
const SETTLE_MS = 2 * 60 * 1000;
const CURRENT = 'keito:current';

export const emptyDoc = (title?: string): Doc => ({ version: 1, id: randomId(), meta: emptyMeta(title), nodes: [], edges: [] });

/**
 * A new board of a kind, in a project. A sequence board starts with a diagram to write over, so
 * it is never a blank page.
 */
export function startBoard(kind: BoardKind, title: string, project: string): Doc {
  const doc: Doc = { ...emptyDoc(title.trim() || KINDS[kind].label), kind: kind === 'system' ? undefined : kind };
  doc.meta.project = project.trim();
  if (kind === 'sequence') doc.nodes.push(makeNode('sequence', 0, 0, new Set(), SEQUENCE_SAMPLE));
  return doc;
}


/** Each board has its own address: `#/b/<id>`. */
const boardInUrl = (): string | null => /^#\/b\/([\w-]+)/.exec(location.hash)?.[1] ?? null;
function showInUrl(id: string): void {
  if (boardInUrl() !== id) history.replaceState(null, '', `${location.pathname}${location.search}#/b/${id}`);
  localStorage.setItem(CURRENT, id);
}

/**
 * The shared project whose board is on screen (see openCollab), how this page stands with its
 * server, the project's boards (its tabs; none, and no board on screen, once all are deleted), and
 * whether this page's own edits of the board on screen can be undone or redone.
 */
export interface CollabState extends ShareStatus, Steps {
  project: string;
  boards: SharedBoardInfo[];
  /** The project's deleted boards, which `manage.restore` brings back. */
  deleted: SharedBoardInfo[];
  /** Adding, renaming and restoring the project's boards, and renaming the project, for everyone in it. */
  manage: BoardManagement;
  /** Edits the server has not stored are not kept on this device either: they are in this page alone. */
  unkept: boolean;
  /** What the board takes (see Target.takes), without telling the user anything. */
  takes(what: EditKind): boolean;
}

export interface EditOperation {
  readonly origin: unknown;
  readonly board: string;
}
export interface OperationEvent extends EditOperation {
  phase: 'begin' | 'commit' | 'cancel';
}

export interface State {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  boards: BoardInfo[];
  selection: string[];
  /** What a search on the board found: shown as it is while the rest fades; null when not searching. */
  found: string[] | null;
  tool: Tool;
  view: View;
  editing: string | null;
  panel: Panel;
  /** Which side panels are open. */
  docks: Record<Dock, boolean>;
  /** False until the first board has been loaded from storage. */
  ready: boolean;
  /** Where boards are kept: a folder on disk (server) or this browser (local). */
  mode: 'server' | 'local';
  /**
   * How the board on screen stands with its storage. `conflict`: changed elsewhere (the command line
   * …) while it had unsaved edits here; `gone`: deleted elsewhere while open here. Either is written
   * again only when the user says.
   */
  saving: 'saved' | 'saving' | 'error' | 'conflict' | 'gone';
  /** Set while an old revision is on screen in place of the live board (which is not touched). */
  viewing: { entry: Revision; all: Revision[] } | null;
  /** Why the last write failed, while `saving` is 'error'. */
  saveError: string | null;
  /** A short word on what was just done (what a delete took with it …), shown for a moment. */
  notice: string | null;
  /**
   * Set while the board on screen is a shared project's: its edits go to the collaboration server,
   * never to the boards folder or this browser, and `saving` says whether the server has stored them.
   */
  collab: CollabState | null;

  /** Start an operation and push the current doc onto the undo stack (before a drag or a burst). */
  checkpoint(context?: Partial<EditOperation>): void;
  /** Take back the last undo step without leaving it to redo: what it did is called off, not undone. */
  dropStep(): void;
  /** Finish the active operation. */
  commitOperation(): void;
  /** Replace the doc. `record` adds an undo step. */
  setDoc(doc: Doc, record?: boolean): void;
  mutate(fn: (d: Doc) => Doc, record?: boolean): void;
  updateNode(id: string, patch: Partial<Node>, record?: boolean): void;
  updateEdge(id: string, patch: Partial<Edge>, record?: boolean): void;
  removeIds(ids: string[]): void;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
  setTool(tool: Tool): void;
  setView(view: View): void;
  setEditing(id: string | null): void;
  setPanel(panel: Panel): void;
  /** Open or close a side panel (toggled when `on` is left out). */
  setDock(dock: Dock, on?: boolean): void;
  fit(): void;
  openBoard(id: string): void;
  newBoard(doc?: Doc): void;
  deleteBoard(id: string): void;
  /** Give every board of a project another project name (案件名). */
  renameProject(from: string, to: string): void;
  /** Settle a conflict: take the board as it is on disk, or write this page's version over it. */
  resolveConflict(choice: 'reload' | 'overwrite'): void;
  /** Keep the board as it stands now in its history under a name, for good. */
  nameState(name: string): void;
  /** Give a state in the history a name (kept for good), or take it away (empty: it may thin out). */
  renameRevision(id: string, name: string): void;
  viewRevision(id: string): void;
  exitRevision(): void;
  /** Make the revision on screen the live board again. */
  restoreRevision(): void;
  deleteRevision(id: string): void;
  /** Devices saved for reuse, shared by all boards. */
  presets: UserPreset[];
  placing: Placing | null;
  setPlacing(placing: Placing | null): void;
  /** Save a device on the board as a preset (replacing one of the same name, maker and model). */
  savePreset(deviceId: string): void;
  deletePreset(id: string): void;

  /** The other boards of the open board's project, as last read (for sharing things between them). */
  others: Doc[];
  /** Make a node here the same thing as one on another board of the project (whose particulars it takes). */
  linkTo(nodeId: string, target: Entry): void;
  /** A node here stops being shared with the other boards (they keep their own copies). */
  unlink(nodeId: string): void;
  /** Software runs on a device of another board (or on none). */
  runOn(nodeId: string, host: Entry | null): void;
  /**
   * Delete the shared device a device here is one with, from every board of the project, once the
   * user agrees to what goes with it (a shared project's; this machine's boards keep copies alike instead).
   */
  deleteSharedDevice(nodeId: string): void;
  /** Open another board with one of its nodes selected and in view. */
  openAt(boardId: string, nodeId: string): void;
}

/**
 * A session owns its editor, pending work and page subscriptions. `page`: the session is the page's
 * (it follows and shows the address, and hears the page close). `device`: where shared projects are
 * kept on this device; unset, where the store booted says (see Backend.device).
 */
export function createEditSession(options: { page?: boolean; device?: DeviceStore | null } = {}) {
  let disposed = false;
  let generation = 0;
  const active = (): boolean => !disposed;
  /** Work started on an older board cannot change the board now on screen. */
  const scope = (): (() => boolean) => {
    const ticket = generation;
    return () => active() && ticket === generation;
  };
  let unwatch: (() => void) | undefined;
  const cleanups: (() => void)[] = [];
  function frame(fn: () => void): void {
    const current = scope();
    requestAnimationFrame(() => {
      if (current()) fn();
    });
  }
  function subscribe(listener: (s: State, prev: State) => void): void {
    cleanups.push(useStore.subscribe(listener));
  }
  function onWindow<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void): void {
    if (!options.page) return;
    window.addEventListener(type, listener);
    cleanups.push(() => window.removeEventListener(type, listener));
  }
  function showAddress(id: string): void {
    if (options.page) target.boards.address(id);
  }

  let backend: Backend | null = null;
  /** The live board, set aside while an old revision is on screen. */
  let live: Doc | null = null;
  let operation: EditOperation | null = null;
  const operations = new Set<(event: OperationEvent) => void>();

  function onOperation(listener: (event: OperationEvent) => void): () => void {
    operations.add(listener);
    return () => { operations.delete(listener); };
  }
  function checkpoint(context: Partial<EditOperation> = {}): void {
    const s = useStore.getState();
    if (!active() || s.viewing || (context.board !== undefined && context.board !== s.doc.id)) return;
    commitOperation();
    const step = { origin: context.origin === undefined ? 'local' : context.origin, board: s.doc.id };
    operation = step;
    target.edits.begin();
    operations.forEach((hear) => hear({ ...step, phase: 'begin' }));
  }
  function commitOperation(): void {
    if (!operation) return;
    const done = operation;
    operation = null;
    target.edits.end();
    operations.forEach((hear) => hear({ ...done, phase: 'commit' }));
  }
  function dropStep(): void {
    const done = operation;
    // Cleared before the step is put back: what it is put back with is no part of the operation.
    operation = null;
    if (!target.edits.drop()) {
      operation = done;
      return;
    }
    if (done) operations.forEach((hear) => hear({ ...done, phase: 'cancel' }));
  }

  function set(change: Partial<State> | ((s: State) => Partial<State>)): void {
    if (active()) useStore.setState(change);
  }
  const useStore = create<State>((_, get) => {
    return {
      doc: emptyDoc(),
      past: [],
      future: [],
      boards: [],
      selection: [],
      found: null,
      tool: 'select',
      view: { x: 0, y: 0, k: 1 },
      editing: null,
      // `?panel=export` etc. opens a panel on load (handy for deep links).
      panel: (['export', 'boards', 'settings'].includes(new URLSearchParams(location.search).get('panel') ?? '') ? new URLSearchParams(location.search).get('panel') : null) as Panel,
      docks: { library: false, lists: new URLSearchParams(location.search).get('panel') === 'lists', comments: new URLSearchParams(location.search).get('panel') === 'comments' },
      ready: false,
      mode: 'local',
      saving: 'saved',
      viewing: null,
      saveError: null,
      notice: null,
      collab: null,
      presets: [],
      others: [],
      placing: null,
      setPlacing: (placing) => set({ placing, ...(placing ? { tool: 'select' as Tool } : {}) }),

      checkpoint,
      dropStep,
      commitOperation,
      setDoc: (doc, record = true) => {
        // An earlier state on screen is for looking at: an edit there would be lost, or restored
        // along with it unseen.
        if (get().viewing) return;
        target.edits.edit(doc, record);
      },
      mutate: (fn, record = true) => get().setDoc(fn(get().doc), record),
      updateNode: (id, patch, record = true) =>
        get().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as Node) : n)) }), record),
      updateEdge: (id, patch, record = true) =>
        get().mutate((d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }), record),
      removeIds: (ids) => {
        if (!ids.length) return;
        const gone = new Set(ids);
        const d = get().doc;
        // Lines go with the things they join: said, since they were not among what was picked.
        const along = d.edges.filter((e) => !gone.has(e.id) && (gone.has(e.from.node) || gone.has(e.to.node))).length;
        get().mutate((d) => ({
          ...d,
          nodes: d.nodes.filter((n) => !gone.has(n.id)),
          edges: d.edges.filter((e) => !gone.has(e.id) && !gone.has(e.from.node) && !gone.has(e.to.node)),
        }));
        set({ selection: [], editing: null });
        if (along && !get().viewing) say(`つながっていた線 ${along} 本も一緒に消しました（⌘Z で戻せます）`);
      },
      undo: () => {
        commitOperation();
        target.edits.undo();
      },
      redo: () => {
        commitOperation();
        target.edits.redo();
      },
      select: (selection) => set({ selection }),
      // Arming a tool puts away whatever was waiting to be placed.
      setTool: (tool) => void (takes(tool) && set({ tool, placing: null })),
      setView: (view) => set({ view }),
      setEditing: (editing) => void ((!editing || takes('typing')) && set({ editing })),
      setPanel: (panel) => set({ panel }),
      setDock: (dock, on) => set((s) => ({ docks: { ...s.docks, [dock]: on ?? !s.docks[dock] } })),
      fit: () => {
        const el = document.getElementById('canvas');
        const box = docBounds(get().doc);
        if (!el || !box) return set({ view: { x: 0, y: 0, k: 1 } });
        const { width, height } = el.getBoundingClientRect();
        const k = Math.min(1.25, (width - 120) / Math.max(1, box.w), (height - 120) / Math.max(1, box.h));
        set({ view: { k, x: (width - box.w * k) / 2 - box.x * k, y: (height - box.h * k) / 2 - box.y * k } });
      },
      openBoard: (id) => {
        // Not a no-op: a load still under way would put another board over this one, which a quick
        // click back to its tab no longer wants.
        if (id === get().doc.id) return void (loading = undefined);
        // Not started over: a new request supersedes the load under way, so a key held down would
        // keep the board from opening.
        if (id === loading?.id) return;
        if (!target.boards.open(id)) openLocal(id);
      },
      newBoard: (doc = emptyDoc()) => void run(async (b, current) => {
        const request = { id: doc.id };
        loading = request;
        try {
          if (!(await leave()) || !current() || loading !== request) return;
          // A file opened from elsewhere may carry its pictures inline; give them a home in the board's folder.
          // History belongs to the board it was recorded on; a copy or an opened file starts without one.
          // An opened file may be of an older form: it is read the way a stored board is.
          // An id the storage cannot take (a file written by hand or another tool) is given a new one.
          // An id already taken in the storage (a board made meanwhile elsewhere, not yet in the list) is
          // never written over: the new board takes another.
          const taken = BOARD_ID.test(doc.id) && !!(await b.load(doc.id).catch(() => null));
          if (!current() || loading !== request) return;
          const id = BOARD_ID.test(doc.id) && !taken ? doc.id : randomId();
          request.id = id;
          const next = await externalize(readBoard({ ...doc, id, revisions: undefined }) ?? { ...doc, id, revisions: undefined }, b);
          if (!current() || loading !== request) return;
          show(next);
          await save.persist(next);
        } finally {
          if (loading === request) loading = undefined;
        }
      }),
      nameState: (name) => void inStore(async (b) => {
        if (get().viewing || !name.trim()) return;
        const doc = get().doc;
        const last = doc.revisions?.at(-1);
        // The state already in the history (nothing changed since): it just takes the name.
        if (last && last.hash === fingerprint(doc)) return setRevisions(b, doc.id, (list) => list.map((r) => (r.id === last.id ? { ...r, name: name.trim() } : r)));
        await snapshot(b, doc, { name: name.trim() });
      }),
      renameRevision: (id, name) => void inStore(async (b) => {
        const board = (live ?? get().doc).id;
        await setRevisions(b, board, (list) => list.map((r) => (r.id === id ? { ...r, name: name.trim() || undefined } : r)));
      }),
      viewRevision: (id) => void inStore(async (b, current) => {
        // The board as it is goes into the history before an older state takes its place on screen.
        if (!get().viewing && !(await leave())) return;
        if (!current()) return;
        const base = live ?? get().doc;
        const all = base.revisions ?? [];
        const i = all.findIndex((r) => r.id === id);
        const snap = i < 0 ? null : await b.loadRevision(base.id, id).catch(() => null);
        if (!current()) return;
        // A state whose drawing is gone (an entry from an older copy of the board) says so plainly.
        if (!snap) return void tell('この時点の図が見つかりませんでした（図のファイルが残っていません）。');
        live = base;
        // On screen the old drawing carries the history up to its own entry, as its sheet would have.
        set({ doc: { ...snap, id: base.id, revisions: all.slice(0, i + 1) }, viewing: { entry: all[i], all }, past: [], future: [], selection: [], editing: null });
        frame(get().fit);
      }),
      exitRevision: () => {
        if (!live) return;
        const doc = live;
        live = null;
        set({ doc, viewing: null, past: [], future: [], selection: [], editing: null });
        frame(get().fit);
      },
      restoreRevision: () => void inStore(async (b, current) => {
        const { viewing, doc } = get();
        if (!viewing || !live) return;
        const before = live;
        // What is replaced goes into the history first, so going back is never a loss.
        const kept = await snapshot(b, before, { source: 'restore', summary: `${viewing.entry.name ?? 'この時点'}に戻す前` });
        if (!current()) return;
        live = null;
        // The state gone back to is already in the history: it is the base for what comes next.
        snapBase = doc;
        baseKept = true;
        // The old drawing becomes the live board (and is saved); undo brings back what it replaced.
        set({ doc: { ...doc, revisions: kept ?? before.revisions }, viewing: null, past: [before], future: [], selection: [], editing: null });
      }),
      deleteRevision: (id) => void inStore(async (b) => {
        if (get().viewing) return;
        const board = get().doc.id;
        await b.removeRevision(board, id);
        if (!active()) return;
        await setRevisions(b, board, (list) => list.filter((r) => r.id !== id));
      }),
      savePreset: (deviceId) => void run(async (b) => {
        const d = get().doc.nodes.find((n) => n.id === deviceId);
        if (d?.type !== 'device') return;
        // Gear and software are kept apart: a PC saved from a system board is no part of a software board.
        const software = kindOf(get().doc).id === 'software';
        const same = (p: UserPreset): boolean => p.name === d.text && p.maker === d.maker && p.model === d.model && !!p.software === software;
        const preset: UserPreset = {
          id: get().presets.find(same)?.id ?? randomId(),
          ...(software ? { software } : {}),
          name: d.text,
          category: d.category,
          maker: d.maker,
          model: d.model,
          note: d.note,
          w: d.w,
          ports: d.ports.map((p) => ({ ...p })),
          watts: d.watts,
          capacity: d.capacity,
          url: d.url,
          color: d.color,
        };
        // Read anew first: another window may have saved presets of its own since this one read them.
        const now = await b.loadPresets().catch(() => get().presets);
        if (!active()) return;
        const presets = [preset, ...now.filter((p) => !same(p) && p.id !== preset.id)];
        await b.savePresets(presets);
        if (active()) set({ presets });
      }),
      deletePreset: (id) => void run(async (b) => {
        const now = await b.loadPresets().catch(() => get().presets);
        if (!active()) return;
        const presets = now.filter((p) => p.id !== id);
        await b.savePresets(presets);
        if (active()) set({ presets });
      }),
      renameProject: (from, to) =>
        void inStore(async (b) => {
          const name = to.trim();
          // An older state on screen is never written; the live board must be the one renamed.
          if (!name || name === from || get().viewing) return;
          // The board on screen changes in place (one undo step); the others are read, renamed, written.
          if ((get().doc.meta.project ?? '') === from) get().mutate((d) => ({ ...d, meta: { ...d.meta, project: name } }));
          const missed: string[] = [];
          try {
            for (const info of get().boards) {
              if ((info.project ?? '') !== from || info.id === get().doc.id) continue;
              // A board that cannot be written now (changed elsewhere meanwhile …) keeps its old name;
              // it is no reason to stop, nor a conflict of the board on screen.
              try {
                const doc = await b.load(info.id);
                if (!active()) return;
                if (doc && (doc.meta.project ?? '') === from) await b.save({ ...doc, meta: { ...doc.meta, project: name } });
              } catch (e) {
                console.warn(`[keito] ${info.title}: project not renamed`, e);
                missed.push(info.title);
              }
            }
          } finally {
            if (active()) {
              const boards = await b.list();
              if (active()) set({ boards });
            }
          }
          if (!active()) return;
          if (missed.length) void tell(`次のボードは案件名を変えられませんでした（ほかで更新中など）: ${missed.join('、')}`);
        }),
      resolveConflict: (choice) =>
        void inStore(async (b, current) => {
          const mine = get().doc;
          if (choice === 'overwrite') {
            await b.save(mine, true);
            if (!current()) return;
            save.setStored(mine);
            // Edits made while it was being written go out after it.
            if (get().doc !== mine) {
              set({ saving: 'saving' });
              return void save.persist(get().doc);
            }
            return set({ saving: 'saved' });
          }
          const fresh = await b.load(mine.id);
          if (!current() || !fresh) return;
          save.setStored(fresh);
          const shown = fitLegends(fresh);
          // This page's version stays one undo away, should it be wanted after all.
          adopt(shown, () => set({ doc: shown, past: [mine], future: [], selection: get().selection.filter((id) => fresh.nodes.some((n) => n.id === id) || fresh.edges.some((e) => e.id === id)), saving: 'saved' }));
        }),
      linkTo: (nodeId, to) =>
        target.devices ? target.devices.link(nodeId, { board: to.board, node: to.node.id }) : void inStore(async (b) => {
          if (get().viewing) return;
          const current = scope();
          const key = await shareKey(b, to);
          if (!current() || !key) return;
          const fresh = (get().others.find((d) => d.id === to.board)?.nodes.find((n) => n.id === to.node.id) as ShareNode | undefined) ?? to.node;
          // The other board's particulars win: it is the one being linked to.
          sharing(() => get().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId && n.type === 'device' ? { ...takeFrom(n, fresh), shared: key, sharedAt: fresh.sharedAt } : n)) })));
        }),
      unlink: (nodeId) => (target.devices ? target.devices.unlink(nodeId) : get().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId && n.type === 'device' ? { ...n, shared: undefined, sharedAt: undefined } : n)) }))),
      runOn: (nodeId, host) =>
        target.devices ? target.devices.runOn(nodeId, host && { board: host.board, node: host.node.id }) : void inStore(async (b) => {
          if (get().viewing) return;
          const current = scope();
          const key = host ? ((await shareKey(b, host)) ?? undefined) : undefined;
          if (!current() || (host && !key)) return;
          get().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId && n.type === 'device' ? { ...n, runsOn: key } : n)) }));
          pullIn();
        }),
      deleteSharedDevice: (nodeId) => (target.devices ? void target.devices.remove(nodeId) : refuse()),
      openAt: (boardId, nodeId) => {
        // A shared project's board is put on screen at once (see collab/tabs.ts).
        if (!target.local && (boardId === get().doc.id || target.boards.open(boardId))) return showAt(nodeId);
        void run(async (b) => {
          if (boardId !== get().doc.id && (await switchTo(b, boardId)) !== 'shown') return;
          showAt(nodeId);
        });
      },
      deleteBoard: (id) => {
        if (!target.boards.remove(id)) removeLocal(id);
      },
    };
  });

  const save = localSaving({ get: useStore.getState, set, backend: () => backend, active, scope, say, beforeFlush, beforeLeave });
  const edits = localEdits({ get: useStore.getState, set, checkpoint });

  /** The target of a board in this machine's store (see show): the boards folder, or this browser. */
  const localTarget: Target = {
    edits,
    saving: save,
    boards: { open: openLocal, remove: removeLocal, address: showInUrl },
    local: { run, keepImage: keepImageLocal, changed, pickUp: () => void run(pickUp), readProject },
    devices: null,
    refusal: null,
    close: () => {},
  };
  let target: Target = localTarget;

  /** Select a node of the board on screen and, once the board has been fitted to the window, put it in the middle. */
  function showAt(nodeId: string): void {
    set({ selection: [nodeId] });
    frame(() => frame(() => centerOn(nodeId)));
  }

  /** Tell the user the board on screen does not take what was asked of it. */
  function refuse(): void {
    if (target.refusal) say(target.refusal);
  }

  /** Whether the board on screen takes a tool armed, or text typed in; the user is told when not. */
  function takes(what: EditKind): boolean {
    if (target.edits.takes(what)) return true;
    refuse();
    return false;
  }

  /** Run an action on the board in this machine's store (its history, its project); refused, and said, where it is kept elsewhere. */
  function inStore(fn: StoreAction): Promise<void> {
    if (target.local) return target.local.run(fn);
    refuse();
    return Promise.resolve();
  }

  /** Open a board of this machine's store in place of the one on screen. */
  function openLocal(id: string): boolean {
    void run(async (b, current) => {
      const result = await switchTo(b, id);
      if (result === 'stayed') showAddress(useStore.getState().doc.id);
      else if (result === 'unreadable') await reportUnreadable(b, current);
    });
    return true;
  }

  /** Delete a board of this machine's store; the one on screen gives way to the first that can be read, or a new one. */
  function removeLocal(id: string): boolean {
    void run(async (b) => {
      if (id === useStore.getState().doc.id) save.cancel();
      await b.remove(id);
      if (!active()) return;
      const boards = await b.list();
      if (!active()) return;
      // A deleted fellow of the project is no longer written to when something shared changes.
      set({ boards, others: useStore.getState().others.filter((d) => d.id !== id) });
      if (id !== useStore.getState().doc.id) return;
      const current = scope();
      const request = { id };
      loading = request;
      try {
        let next: Doc | null = null;
        for (const info of boards) {
          request.id = info.id;
          next = await tryLoad(b, info.id);
          if (!current() || loading !== request) return;
          if (next) break;
        }
        if (next) return show(next);
        next = emptyDoc();
        show(next);
        await save.persist(next);
      } finally {
        if (loading === request) loading = undefined;
      }
    });
    return true;
  }

  /** Deleted boards that can be put back (none before storage is connected). */
  const deletedBoards = async (): Promise<TrashedBoard[]> => (backend ? backend.trash() : []);

  /** Put a deleted board back and open it. Throws, in words for the user, when it cannot be. */
  async function restoreBoard(key: string): Promise<void> {
    const b = backend;
    const current = scope();
    if (!b) return;
    const id = await b.restore(key);
    if (!active()) return;
    const boards = await b.list();
    if (!active()) return;
    set({ boards });
    if (current()) useStore.getState().openBoard(id);
  }

  /** Run a storage action; a failure is said, and marks the board unsaved only if it is. */
  async function run(fn: StoreAction): Promise<void> {
    if (!backend) return;
    const current = scope();
    try {
      await fn(backend, current);
    } catch (e) {
      if (!current()) return;
      // Written elsewhere since it was read here: the user settles it (see resolveConflict).
      if (e instanceof Conflict) return void save.enterConflict('conflict');
      console.error(e);
      // Something done alongside the board (a preset, a state of its history, opening another)
      // failed: said so, without calling a board that is saved unsaved.
      target.saving.failed();
      void tell(`うまくいきませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Automatic history. The board as last kept (or as it was opened) is `snapBase`; once editing
   * pauses, a board that differs from it goes into the history. The state it was opened in is kept
   * first, at the first edit, unless the history already ends with it.
   */
  let snapBase: Doc | null = null;
  let baseKept = false;
  /** Set while a board written elsewhere is taken in: that is no edit, and starts a new base. */
  let adopting = false;
  /** The opened state being put into the history, for anything that must wait for it. */
  let keeping: Promise<void> | null = null;
  let settleTimer: number | undefined;

  /**
   * Put `doc` into its board's history (thinning older unnamed states); returns the new list.
   * The change is described against `previous`, by default the state last kept.
   */
  async function snapshot(b: Backend, doc: Doc, extra: Partial<Revision> = {}, previous: Doc | null = snapBase): Promise<Revision[] | null> {
    // A state the history already ends with is not kept twice (unless it is being given a name).
    const current = live?.id === doc.id ? live : useStore.getState().doc;
    if (!extra.name && current.id === doc.id && current.revisions?.at(-1)?.hash === fingerprint(doc)) {
      snapBase = doc;
      return current.revisions ?? null;
    }
    const before = previous?.id === doc.id ? previous : null;
    const entry = entryFor(doc, before, randomId(), { source: 'auto', ...extra });
    await b.saveRevision(doc.id, entry.id, drawingOf(doc));
    if (!active()) return null;
    let drop: string[] = [];
    let kept: Revision[] = [];
    await setRevisions(b, doc.id, (list) => {
      const out = thin([...list, entry]);
      drop = out.drop;
      kept = out.keep;
      return out.keep;
    });
    for (const id of drop) {
      if (!active()) return null;
      await b.removeRevision(doc.id, id).catch(() => {});
    }
    if (!active()) return null;
    if (doc.id === (live ?? useStore.getState().doc).id) snapBase = doc;
    return kept;
  }

  /** Put a board written elsewhere on screen as the new base of the history, without counting it an edit. */
  function adopt(shown: Doc, apply: () => void): void {
    adopting = true;
    try {
      apply();
    } finally {
      adopting = false;
    }
    snapBase = shown;
    baseKept = false;
  }

  /** Keep the board now if it changed since it was last kept (before leaving it, after a pause). */
  async function settle(b: Backend): Promise<void> {
    const current = scope();
    clearTimeout(settleTimer);
    // Only a board that changed since it was opened (or last kept) has anything to keep.
    const changed = () => {
      const { doc, viewing, ready, saving } = useStore.getState();
      return ready && !viewing && saving !== 'conflict' && !!snapBase && snapBase.id === doc.id && fingerprint(doc) !== fingerprint(snapBase);
    };
    if (!changed()) return;
    await keepBase(b);
    if (current() && changed()) await snapshot(b, useStore.getState().doc);
  }

  /** The state the board was opened in, into the history if it does not end with it already. */
  function keepBase(b: Backend): Promise<void> {
    if (keeping) return keeping;
    if (baseKept || !snapBase) return Promise.resolve();
    baseKept = true;
    const base = snapBase;
    const current = scope();
    const task = (async () => {
      const last = (useStore.getState().doc.revisions ?? []).at(-1);
      if (last?.hash === fingerprint(base)) return;
      // Described against the last state kept, which may be from long before (or from elsewhere).
      const previous = last ? await b.loadRevision(base.id, last.id).catch(() => null) : null;
      if (current()) await snapshot(b, base, {}, previous);
    })()
      // Not kept after all (the board not yet written, storage full …): tried again at the next edit.
      .catch((e) => {
        if (snapBase === base) baseKept = false;
        throw e;
      })
      .finally(() => { if (keeping === task) keeping = null; });
    keeping = task;
    return task;
  }

  /**
   * Run a step of the automatic history. Its failure (browser storage full …) is logged, never shown
   * as a failed save: the board itself is saved all the same.
   */
  async function quietly(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.warn('[keito] history not kept:', e);
    }
  }

  /** One state from the open board's history, as it was. */
  async function loadState(id: string): Promise<Doc | null> {
    const board = live ?? useStore.getState().doc;
    return backend ? backend.loadRevision(board.id, id) : null;
  }

  /** The open board as it is now (not an older state shown in its place). */
  const currentBoard = (): Doc => live ?? useStore.getState().doc;

  /**
   * Update a board's list of revisions once the files are written. The writes take a moment, and
   * by then another board may be open: the list then goes to the board it belongs to, on disk.
   */
  async function setRevisions(b: Backend, board: string, change: (list: Revision[]) => Revision[]): Promise<void> {
    const s = useStore.getState();
    if (s.doc.id === board && !s.viewing) return s.setDoc({ ...s.doc, revisions: change(s.doc.revisions ?? []) }, false);
    if (live?.id === board) {
      live = { ...live, revisions: change(live.revisions ?? []) };
      return;
    }
    const saved = await b.load(board);
    if (active() && saved) await b.save({ ...saved, revisions: change(saved.revisions ?? []) });
  }

  /**
   * Start the open board's session afresh: what was last written, the base of its history, and no
   * save, retry or keeping pending from the board before (whatever was wrong with that one is not
   * this one's). Pending work belongs to the board that started it.
   */
  function resetSession(doc: Doc, shown: Doc): void {
    commitOperation();
    target.close();
    generation++;
    loading = undefined;
    clearTimeout(pushTimer);
    pushTimer = undefined;
    clearTimeout(projectTimer);
    save.reset(doc);
    live = null;
    snapBase = shown;
    baseKept = false;
    keeping = null;
    clearTimeout(settleTimer);
  }

  /** Put a freshly loaded (or created) board on screen. */
  function show(doc: Doc): void {
    // The base is the board as shown (legends fitted), so fitting alone never reads as an edit.
    const shown = fitLegends(doc);
    resetSession(doc, shown);
    target = localTarget;
    const back = edits.takeUp(shown);
    set({ doc: shown, viewing: null, past: back?.past ?? [], future: back?.future ?? [], selection: [], editing: null, others: [], placing: null, saving: 'saved', saveError: null, collab: null });
    showAddress(doc.id);
    if (back) set({ view: back.view });
    else frame(useStore.getState().fit);
    void readProject();
  }

  /**
   * Open a shared project's board in place of the board on screen, once the server has let this page
   * in and sent the project; whether it was. Turned away (no grant for the project, another schema)
   * or not reached, the board on screen stays and the user is told why. A project with no board
   * opens empty (see sharedTarget).
   */
  async function openCollab(join: SharedJoin): Promise<boolean> {
    const b = backend;
    const current = scope();
    if (!b) return false;
    // Loaded only when a shared project is opened: Yjs and the provider stay out of the app's first load.
    const { joinProject, refusalText } = await import('../collab/client');
    if (!current()) return false;
    const project = joinProject(join, options.device !== undefined ? options.device : b.device !== undefined ? b.device : browserDevice);
    try {
      await project.ready;
    } catch (e) {
      project.close();
      if (current()) void tell(e instanceof Error ? e.message : String(e));
      return false;
    }
    if (!current()) {
      project.close();
      return false;
    }
    const was = useStore.getState();
    // Not `leave` while starting: no board is on screen yet, only the empty one the page begins with.
    if ((save.stored() && !(await leave())) || !current()) {
      project.close();
      return false;
    }
    if (save.stored()) target.edits.keepSteps(was);
    resetSession(was.doc, was.doc);
    const shared = sharedTarget(join.project, project, {
      get: useStore.getState,
      set,
      say,
      refuse,
      checkpoint,
      commitOperation,
      operating: () => !!operation,
      opened: (view) => {
        showAddress(useStore.getState().doc.id);
        if (view) set({ view });
        else frame(useStore.getState().fit);
      },
      refused: (refusal) => leaveShared(refusalText(refusal), project.status().pending),
    });
    target = shared;
    shared.start();
    return true;
  }

  /**
   * Leave a shared project that turned this page away while it was open (deleted …) for a board of
   * this machine: the one last shown here, else the first. The user is told why, and of the edits
   * the project will never store.
   */
  function leaveShared(why: string, unstored: number): void {
    const { boards } = useStore.getState();
    const last = localStorage.getItem(CURRENT);
    const back = boards.find((b) => b.id === last)?.id ?? boards[0]?.id;
    if (back) openLocal(back);
    else
      void run(async () => {
        const doc = emptyDoc();
        show(doc);
        await save.persist(doc);
      });
    void tell(`${why}。この端末のボードに戻ります。${unstored ? `\n共同編集先に保存されていなかった変更 ${unstored} 件は、保存されません。` : ''}`);
  }

  /** Bring a part of the board to the middle of the view, zooming in if it would be too small to read. */
  function showRect(r: Rect): void {
    const { view } = useStore.getState();
    const el = document.getElementById('canvas');
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const fits = Math.min((width - 120) / Math.max(1, r.w), (height - 120) / Math.max(1, r.h));
    const k = Math.min(Math.max(view.k, 0.8), Math.max(fits, 0.2), 1.5);
    set({ view: { k, x: width / 2 - (r.x + r.w / 2) * k, y: height / 2 - (r.y + r.h / 2) * k } });
  }

  /**
   * Bring things (nodes, or lines by their two ends) into view when any of them is out of it: the
   * view moves to centre them, at the same zoom. Already in view, nothing moves.
   */
  function reveal(ids: string[]): void {
    const { doc, view } = useStore.getState();
    const want = new Set(ids);
    for (const e of doc.edges) if (want.has(e.id)) want.add(e.from.node).add(e.to.node);
    const rects = doc.nodes.filter((n) => want.has(n.id)).map(nodeRect);
    const el = document.getElementById('canvas');
    if (!rects.length || !el) return;
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));
    const { width, height } = el.getBoundingClientRect();
    const inView = x0 * view.k + view.x >= 0 && y0 * view.k + view.y >= 0 && x1 * view.k + view.x <= width && y1 * view.k + view.y <= height;
    if (inView) return;
    set({ view: { ...view, x: width / 2 - ((x0 + x1) / 2) * view.k, y: height / 2 - ((y0 + y1) / 2) * view.k } });
  }

  function centerOn(nodeId: string): void {
    const { doc, view } = useStore.getState();
    const n = doc.nodes.find((x) => x.id === nodeId);
    const el = document.getElementById('canvas');
    if (!n || !el) return;
    const r = nodeRect(n);
    const { width, height } = el.getBoundingClientRect();
    set({ view: { ...view, x: width / 2 - (r.x + r.w / 2) * view.k, y: height / 2 - (r.y + r.h / 2) * view.k } });
  }

  /** ⌘S, or "もう一度" after a failed write: what is pending is written now (it is otherwise written by itself). */
  const saveNow = (): Promise<void> => target.saving.saveNow();

  let noticeTimer = 0;
  /** Show a short word for a moment. */
  function say(text: string): void {
    clearTimeout(noticeTimer);
    set({ notice: shortcuts(text) });
    noticeTimer = window.setTimeout(() => set({ notice: null }), 4000);
  }

  /**
   * What goes out before a flush writes the board itself: the state it was opened in into its
   * history, and the shared things edited here to the project's other boards.
   */
  async function beforeFlush(): Promise<void> {
    const current = scope();
    if (keeping) await keeping.catch(() => {});
    if (current() && pushTimer !== undefined) await pushOut().catch(() => {});
  }

  /**
   * The latest request to open a board, until its load ends or is cancelled: an earlier one that
   * finishes later is dropped.
   */
  let loading: { id: string } | undefined;

  /** The id of the board being loaded, if any. */
  const boardLoading = (): string | undefined => loading?.id;

  /** Leave the board on screen: its state kept in the history, its changes written (or let go). */
  function leave(): Promise<boolean> {
    commitOperation();
    return target.saving.leave();
  }
  async function beforeLeave(): Promise<void> {
    const b = backend;
    if (b) await quietly(() => settle(b));
  }

  /**
   * Leave the board on screen for another and show that one, the board left keeping its undo steps
   * and view for a return to it: 'shown'; 'stayed' when the user kept the one on screen;
   * 'superseded' when another board was asked for meanwhile (that one is shown, not this);
   * 'unreadable' when it cannot be read.
   */
  async function switchTo(b: Backend, id: string): Promise<'shown' | 'stayed' | 'superseded' | 'unreadable'> {
    const was = useStore.getState();
    const request = { id };
    loading = request;
    const current = scope();
    const superseded = () => !current() || loading !== request;
    try {
      const left = await leave();
      if (superseded()) return 'superseded';
      if (!left) return 'stayed';
      const doc = await tryLoad(b, id);
      if (superseded()) return 'superseded';
      if (!doc) return 'unreadable';
      target.edits.keepSteps(was);
      show(doc);
      return 'shown';
    } finally {
      if (loading === request) loading = undefined;
    }
  }

  /** A board that could not be read (deleted elsewhere, or its file broken): the list follows, and the user is told. */
  async function reportUnreadable(b: Backend, current: () => boolean): Promise<void> {
    const boards = await b.list();
    if (!active()) return;
    set({ boards });
    if (!current()) return;
    showAddress(useStore.getState().doc.id);
    void tell('そのボードを開けませんでした（ほかの場所で削除されたか、ファイルが読めない状態です）。');
  }

  // Keep the signal-type registry in step with the board on screen.
  if (options.page) {
    registerSignals(useStore.getState().doc.signals);
    subscribe((s, prev) => {
      if (s.doc.signals !== prev.doc.signals) registerSignals(s.doc.signals);
    });
  }

  // A tool the board's kind does not offer (left armed from another board, or before the kind
  // changed) goes back to selecting: its button is not even on the toolbar.
  subscribe((s) => {
    if (s.tool !== 'select' && s.tool !== 'pan' && !KINDS[s.doc.kind ?? 'system']?.tools.includes(s.tool)) set({ tool: 'select' });
  });

  subscribe((s, prev) => target.local?.changed(s, prev));

  /** What follows in this machine's store from a change on screen. */
  function changed(s: State, prev: State): void {
    keepHistory(s, prev);
    stampShared(s, prev);
    followProject(s, prev);
    save.autosave(s, prev);
  }

  /** History: the opened state is kept at the first edit, the edited one once editing pauses. */
  function keepHistory(s: State, prev: State): void {
    if (!s.ready || s.viewing || adopting || s.doc === prev.doc || s.doc.id !== prev.doc.id || !backend) return;
    const b = backend;
    if (!baseKept) void quietly(() => keepBase(b));
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => void quietly(() => settle(b)), SETTLE_MS);
  }

  /**
   * Sharing between the boards of a project (see shared.ts). The other boards are read when a board
   * is opened, and whenever one of them is written; the open board takes in newer particulars from
   * them. A shared thing edited here is marked as the newest and written through to the others.
   */
  let sharingNow = false;
  /** Changes made by sharing itself (taking in, linking): no edit of the shared particulars. */
  function sharing(fn: () => void): void {
    sharingNow = true;
    try {
      fn();
    } finally {
      sharingNow = false;
    }
  }

  /** Boards read as they are stored, by id (those not found left out): what the project's export takes beside `others`. */
  async function loadBoards(ids: string[]): Promise<Doc[]> {
    const b = backend;
    if (!b) return [];
    const docs = await Promise.all(ids.map((id) => b.load(id).catch(() => null)));
    return docs.filter((d): d is Doc => !!d);
  }

  let projectRead = 0;
  async function readProject(): Promise<void> {
    const b = backend;
    const current = scope();
    if (!b) return;
    const doc = currentBoard();
    const project = doc.meta.project?.trim();
    const ticket = ++projectRead;
    const others: Doc[] = [];
    if (project)
      for (const info of useStore.getState().boards) {
        if (info.id === doc.id || (info.project ?? '').trim() !== project) continue;
        const d = await b.load(info.id).catch(() => null);
        if (!current()) return;
        if (d && (d.meta.project ?? '').trim() === project) others.push(d);
      }
    // Another board opened (or another read started) meanwhile: this one is out of date.
    if (!current() || ticket !== projectRead || currentBoard().id !== doc.id) return;
    set({ others });
    pullIn();
  }

  /** Take in what the other boards of the project have newer. The undo steps take it in too, so undoing never brings an old name back. */
  function pullIn(): void {
    const s = useStore.getState();
    if (!s.ready || s.viewing || s.editing || s.saving === 'conflict') return;
    const entries = catalog([s.doc, ...s.others]);
    const next = pull(s.doc, entries);
    if (next === s.doc) return;
    const fix = (d: Doc): Doc => (d.id === s.doc.id ? pull(d, entries) : d);
    sharing(() => set({ doc: fitLegends(next), past: s.past.map(fix), future: s.future.map(fix) }));
  }

  /** The shared key of a node of the project, given one (and written to its board) if it has none yet. */
  async function shareKey(b: Backend, entry: Entry): Promise<string | null> {
    const current = scope();
    if (entry.node.shared) return entry.node.shared;
    const key = newKey();
    const s = useStore.getState();
    if (entry.board === s.doc.id) {
      sharing(() => s.updateNode(entry.node.id, { shared: key, sharedAt: Date.now() }, false));
      return key;
    }
    try {
      const d = await b.load(entry.board);
      if (!current()) return null;
      const n = d?.nodes.find((x) => x.id === entry.node.id);
      if (!d || !n || n.type !== 'device') return null;
      let next = d;
      if (!n.shared) {
        next = { ...d, nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, shared: key, sharedAt: Date.now() } : x)) };
        await b.save(next);
      }
      if (!current()) return null;
      set((st) => ({ others: st.others.map((o) => (o.id === next.id ? next : o)) }));
      return (next.nodes.find((x) => x.id === n.id) as ShareNode).shared ?? null;
    } catch (e) {
      if (!current()) return null;
      // The other board could not be written (changed elsewhere just now …): that is not this board's conflict.
      console.warn('[keito] could not share with', entry.boardTitle, e);
      void tell(`「${entry.boardTitle}」に書き込めませんでした。少し待ってからもう一度試してください。`);
      return null;
    }
  }

  let pushTimer: number | undefined;
  function schedulePush(): void {
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => void pushOut(), 800);
  }

  /** Write the shared things edited here through to the other boards of the project. */
  async function pushOut(): Promise<void> {
    clearTimeout(pushTimer);
    pushTimer = undefined;
    const b = backend;
    const s = useStore.getState();
    if (!b || s.viewing || !s.doc.meta.project?.trim()) return;
    const current = scope();
    const doc = s.doc;
    const mine = catalog([doc]);
    const others = [...s.others];
    for (const [i, d] of others.entries()) {
      try {
        // Read anew, so as not to write over a change made to it elsewhere meanwhile; one deleted
        // elsewhere is left deleted.
        const fresh = await b.load(d.id);
        if (!current()) return;
        if (!fresh) continue;
        const next = pull(fresh, mine);
        if (next !== fresh) await b.save(next);
        others[i] = next;
      } catch (e) {
        // It takes the change in when it is next opened (it reads the newest from this board then).
        console.warn(`[keito] ${d.meta.title}: shared change not written`, e);
      }
    }
    if (current() && useStore.getState().doc.id === doc.id) set({ others });
  }

  /** A shared thing edited here (by hand, undo, the text panel …) becomes the newest version of it. */
  function stampShared(s: State, prev: State): void {
    if (!s.ready || s.viewing || adopting || sharingNow || s.doc === prev.doc || s.doc.id !== prev.doc.id) return;
    const next = stamp(prev.doc, s.doc, Date.now());
    if (next === s.doc) return;
    sharing(() => set({ doc: next }));
    schedulePush();
  }

  let projectTimer: number | undefined;
  /** The board moved to another project (or into one): its fellows are others now. */
  function followProject(s: State, prev: State): void {
    if (s.doc.id !== prev.doc.id || s.viewing || (s.doc.meta.project ?? '') === (prev.doc.meta.project ?? '')) return;
    projectRead++;
    clearTimeout(projectTimer);
    projectTimer = window.setTimeout(() => void readProject(), 600);
  }

  /** Store a picture for the current board; returns the `src` an image node should keep (the picture itself where the board is kept elsewhere). */
  const storeImage = (dataUrl: string): Promise<string> => (target.local ? target.local.keepImage(dataUrl) : Promise.resolve(dataUrl));
  async function keepImageLocal(dataUrl: string): Promise<string> {
    const b = backend;
    const current = scope();
    const id = useStore.getState().doc.id;
    if (!b || !b.assets) return dataUrl;
    // The board's folder must exist before a picture can go into it.
    if (!useStore.getState().boards.some((b) => b.id === useStore.getState().doc.id)) await save.flush();
    return current() ? b.putAsset(id, dataUrl) : dataUrl;
  }

  /** A board read, or nothing when it cannot be (gone, or its file broken): one bad board never stops the rest. */
  async function tryLoad(b: Backend, id: string): Promise<Doc | null> {
    try {
      return await b.load(id);
    } catch (e) {
      console.warn(`[keito] ${id}: could not be read`, e);
      return null;
    }
  }

  /** First run against the on-disk store: carry over the boards this browser was keeping. */
  async function migrate(b: Backend): Promise<void> {
    if (b.mode !== 'server' || localStorage.getItem('keito:migrated')) return;
    const have = new Set((await b.list()).map((x) => x.id));
    for (const doc of localBoards()) {
      if (!active()) return;
      // One that cannot be carried over (an id the folder cannot take …) stays in the browser.
      if (!have.has(doc.id)) {
        try {
          const next = await externalize(doc, b);
          if (!active()) return;
          await b.save(next);
        } catch (e) {
          console.warn(`[keito] ${doc.meta.title}: not carried over`, e);
        }
      }
    }
    // The browser copies are left in place as a backup.
    if (!active()) return;
    localStorage.setItem('keito:migrated', new Date().toISOString());
  }

  /**
   * Connect to storage and load the board named in the URL (or the last one used). The desktop app
   * hands in its own store; in a browser it is found (see connect).
   */
  async function boot(given?: Backend, opening?: SharedJoin): Promise<void> {
    if (!active()) return;
    const current = scope();
    try {
      const b = await connect(given, !!options.page);
      if (!active()) return;
      backend = b;
      if (options.page) await migrate(b);
      if (!active()) return;
      let boards = await b.list();
      if (!active()) return;
      const wanted = options.page ? boardInUrl() ?? localStorage.getItem(CURRENT) : null;
      let doc = wanted ? await tryLoad(b, wanted) : null;
      if (!active()) return;
      for (const info of boards) {
        if (doc) break;
        doc = await tryLoad(b, info.id);
        if (!active()) return;
      }
      // Boards there, and none of them could be read: never taken for a first run (the sample project
      // would be written in among them). The page says so and stays empty until reloaded.
      if (!doc && boards.length) throw new Error(`ボードを ${boards.length} 枚見つけましたが、どれも読み込めませんでした`);
      // A first run: the sample project, opened on its system diagram.
      if (!doc) {
        const docs = sampleBoards();
        for (const d of [...docs].reverse()) {
          if (!active()) return;
          await b.save(d);
        }
        doc = docs[0];
        boards = await b.list();
        if (!active()) return;
      }
      const presets = await b.loadPresets().catch(() => []);
      if (!active()) return;
      set({ boards, mode: b.mode, ready: true, presets });
      listen(b);
      if (!current()) return;
      const shared = !!opening && (await openCollab(opening));
      if (!current() || shared) return;
      show(doc);
    } catch (e) {
      if (!current()) return;
      console.error(e);
      set({ ready: true, saving: 'error' });
      void tell(`ボードを開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Following a link or the back button to another board.
  onWindow('hashchange', () => {
    const id = boardInUrl();
    if (id && useStore.getState().ready) useStore.getState().openBoard(id);
  });

  /** Take in the board as another writer left it, if nothing here is waiting to be saved. */
  async function pickUp(b: Backend): Promise<void> {
    const current = scope();
    const s = useStore.getState();
    if (!s.ready || s.viewing) return;
    // Unsaved edits here (or text being typed) and a change on disk: the user decides which stays.
    if (s.editing || s.doc !== save.stored()) return void save.enterConflict('conflict');
    const fresh = await b.load(s.doc.id);
    if (!current() || !fresh) return;
    // Reading it took the version on disk as the one to write on next. Something changed here
    // meanwhile must not go out over a change made elsewhere: the user decides which stays. (When the
    // disk holds what this page last wrote, there is nothing to decide.)
    if (useStore.getState().doc !== s.doc) return void (sameBoard(fresh, save.stored()) ? undefined : save.enterConflict('conflict'));
    if (sameBoard(fresh, s.doc)) return;
    save.setStored(fresh);
    const shown = fitLegends(fresh);
    // The board as written elsewhere is the new base; it goes into the history at the next edit here.
    adopt(shown, () => {
      // The history was made on the version just replaced: undoing into it would write that old
      // version back over what was saved elsewhere. It starts over from the version read in.
      const keep = (id: string) => fresh.nodes.some((n) => n.id === id) || fresh.edges.some((e) => e.id === id);
      set({ doc: shown, selection: s.selection.filter(keep), past: [], future: [] });
    });
    pullIn();
  }

  // Coming back to the tab: pick up what another tab (or an edit to the file) saved meanwhile.
  onWindow('focus', () => {
    const s = useStore.getState();
    // Coming back with nothing unsaved: just look. A conflict is only claimed when something changed.
    if (s.ready && !s.viewing && !s.editing && s.doc === save.stored()) target.local?.pickUp();
    // Other boards may have changed too (another tab, browser storage has no events): new ones,
    // other titles or projects for the tabs, and the project's boards themselves.
    if (s.ready && !s.viewing)
      void run(async (b, current) => {
        const boards = await b.list();
        if (!active()) return;
        set({ boards });
        if (current()) await target.local?.readProject();
      });
  });

  /**
   * Hear about boards written elsewhere (the command line, an edit to the file) as it happens: the
   * open board is read in again, and the list of boards follows new ones and new titles.
   */
  function listen(b: Backend): void {
    unwatch = b.watch?.((news) => {
      const current = scope();
      const s = useStore.getState();
      if (news.id === s.doc.id) {
        if (b.serialOf?.(news.id) !== news.serial) target.local?.pickUp();
      } else
        void b.list().then((boards) => {
          if (!active()) return;
          set({ boards });
          if (!current()) return;
          // A board of this project changed (or joined it): what is shared may have changed with it.
          const project = currentBoard().meta.project?.trim();
          const info = boards.find((x) => x.id === news.id);
          if (project && (info?.project?.trim() === project || useStore.getState().others.some((d) => d.id === news.id))) void target.local?.readProject();
        }, () => {});
    });
  }

  /**
   * Write what is unsaved now, before the app is closed: whether it all went (the desktop app waits
   * for this before letting its window go).
   */
  const flushBeforeClose = (): Promise<boolean> => target.saving.flush();

  onWindow('beforeunload', (e) => {
    commitOperation();
    if (!target.saving.closing()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  onWindow('pagehide', () => target.saving.exit());

  /** What was copied, and from which board (and project). */
  let clipboard: { nodes: Node[]; edges: Edge[]; board: string; project: string } | null = null;

  /** Copy the selected nodes (and the lines between them); false when no node is selected. */
  function copySelection(): boolean {
    const { doc, selection } = useStore.getState();
    const ids = new Set(selection);
    const nodes = doc.nodes.filter((n) => ids.has(n.id));
    if (!nodes.length) return false;
    clipboard = { nodes, edges: doc.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)), board: doc.id, project: doc.meta.project?.trim() ?? '' };
    return true;
  }

  /**
   * Copies of the given nodes, and the lines between them, `offset` down and right of them and
   * selected; right on top, what an Alt-drag moves away, leaving the originals. The clipboard is left
   * alone. `record` makes them an undo step of their own; else the caller keeps the step (the drag's).
   * Says which copy is which: node and line ids, old → new.
   */
  function duplicateInPlace(ids: string[], offset = 0, record = false): Map<string, string> {
    if (!takes('copying')) return new Map();
    const s = useStore.getState();
    const keep = new Set(ids);
    const taken = allIds(s.doc);
    const map = new Map<string, string>();
    // A copy on its own board is another thing: the second PC is not the first.
    const nodes = s.doc.nodes
      .filter((n) => keep.has(n.id))
      .map((n) => {
        const id = freshId(taken, prefixOf(n.id));
        map.set(n.id, id);
        return { ...n, id, x: n.x + offset, y: n.y + offset, ...('shared' in n ? { shared: undefined, sharedAt: undefined } : {}) } as Node;
      });
    const edges = s.doc.edges
      .filter((e) => keep.has(e.from.node) && keep.has(e.to.node))
      .map((e) => {
        const id = freshId(taken, 'e');
        map.set(e.id, id);
        const from = { ...e.from, node: map.get(e.from.node)! };
        const to = { ...e.to, node: map.get(e.to.node)! };
        return { ...e, id, from, to, ...(e.route && { route: e.route.map((p) => ({ x: p.x + offset, y: p.y + offset })) }) };
      });
    s.mutate((d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }), record);
    s.select(nodes.map((n) => n.id));
    return map;
  }

  /**
   * ⌘D: copies of the selected nodes (and the lines between them) a little down and right, selected,
   * as one step. The clipboard is left alone: what ⌘C copied is still what ⌘V pastes, and with no
   * node selected nothing happens (rather than pasting whatever was copied before).
   */
  function duplicateSelection(offset = 30): void {
    const s = useStore.getState();
    const ids = s.selection.filter((id) => s.doc.nodes.some((n) => n.id === id));
    if (ids.length) duplicateInPlace(ids, offset, true);
  }

  /**
   * Paste (or duplicate) with fresh ids, keeping the cables between the copied nodes. The copies go a
   * little down and right of the originals; where that is out of view (another board, a part scrolled
   * away), they go to the middle of the view instead.
   */
  function pasteClipboard(): void {
    if (!clipboard || !takes('copying')) return;
    const s = useStore.getState();
    const offset = pasteShift(clipboard.nodes, s.view);
    const taken = allIds(s.doc);
    const map = new Map<string, string>();
    // Pasted onto another board of the project, a shared thing stays the same thing; a copy on its
    // own board (or elsewhere) is another one: the second PC is not the first. A board that holds no
    // links to other boards (a shared project's, so far) would turn the whole paste away for one.
    const links = target.edits.takes('links');
    const project = s.doc.meta.project?.trim() ?? '';
    const same = links && clipboard.board !== s.doc.id && !!project && clipboard.project === project;
    const here = new Set(s.doc.nodes.map((n) => ('shared' in n ? n.shared : undefined)).filter(Boolean));
    const nodes = clipboard.nodes.map((n) => {
      const id = freshId(taken, prefixOf(n.id));
      map.set(n.id, id);
      const keep = same && 'shared' in n && !!n.shared && !here.has(n.shared);
      const unlinked = {
        ...('shared' in n && !keep ? { shared: undefined, sharedAt: undefined } : {}),
        ...('runsOn' in n && !links ? { runsOn: undefined } : {}),
      };
      return { ...n, id, x: n.x + offset.x, y: n.y + offset.y, ...unlinked } as Node;
    });
    const edges = clipboard.edges.map((e) => ({
      ...e,
      id: freshId(taken, 'e'),
      from: { ...e.from, node: map.get(e.from.node)! },
      to: { ...e.to, node: map.get(e.to.node)! },
      route: e.route?.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })),
    }));
    s.mutate((d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }));
    // Checked after, not before: only the board knows what it turns away (a picture onto a shared board …).
    if (!useStore.getState().doc.nodes.some((n) => n.id === nodes[0].id)) return;
    s.select(nodes.map((n) => n.id));
    clipboard = { ...clipboard, nodes, edges };
  }

  /** How far pasted copies move from what was copied: 30 down and right, or into the middle of the view. */
  function pasteShift(nodes: Node[], view: View): { x: number; y: number } {
    const step = { x: 30, y: 30 };
    const el = document.getElementById('canvas');
    if (!el || !nodes.length) return step;
    const rects = nodes.map(nodeRect);
    const x0 = Math.min(...rects.map((r) => r.x)) + step.x;
    const y0 = Math.min(...rects.map((r) => r.y)) + step.y;
    const x1 = Math.max(...rects.map((r) => r.x + r.w)) + step.x;
    const y1 = Math.max(...rects.map((r) => r.y + r.h)) + step.y;
    const { width, height } = el.getBoundingClientRect();
    // In view if its middle is: a large copy may well stick out at the edges.
    const cx = ((x0 + x1) / 2) * view.k + view.x;
    const cy = ((y0 + y1) / 2) * view.k + view.y;
    if (cx >= 0 && cx <= width && cy >= 0 && cy <= height) return step;
    const mx = (width / 2 - view.x) / view.k;
    const my = (height / 2 - view.y) / view.k;
    return { x: snap(mx - (x0 + x1 - 2 * step.x) / 2), y: snap(my - (y0 + y1 - 2 * step.y) / 2) };
  }

  /**
   * Bring the selected nodes in front of the others, or send them behind (the order they are drawn
   * in). Areas stay behind what they hold whatever their order: this sorts areas among areas.
   */
  function restack(where: 'front' | 'back'): void {
    const s = useStore.getState();
    const ids = new Set(s.selection);
    const picked = s.doc.nodes.filter((n) => ids.has(n.id));
    if (!picked.length) return;
    const rest = s.doc.nodes.filter((n) => !ids.has(n.id));
    s.mutate((d) => ({ ...d, nodes: where === 'front' ? [...rest, ...picked] : [...picked, ...rest] }));
  }

  function align(mode: 'left' | 'top' | 'hcenter' | 'vcenter' | 'hspace' | 'vspace'): void {
    const s = useStore.getState();
    const ids = new Set(s.selection);
    const picked = s.doc.nodes.filter((n) => ids.has(n.id));
    if (picked.length < 2) return;
    const rects = new Map(picked.map((n) => [n.id, nodeRect(n)]));
    const pos = new Map<string, { x: number; y: number }>();
    const all = [...rects.values()];
    if (mode === 'left') for (const n of picked) pos.set(n.id, { x: Math.min(...all.map((r) => r.x)), y: n.y });
    if (mode === 'top') for (const n of picked) pos.set(n.id, { x: n.x, y: Math.min(...all.map((r) => r.y)) });
    if (mode === 'hcenter') {
      const c = all.reduce((a, r) => a + r.x + r.w / 2, 0) / all.length;
      for (const n of picked) pos.set(n.id, { x: Math.round(c - rects.get(n.id)!.w / 2), y: n.y });
    }
    if (mode === 'vcenter') {
      const c = all.reduce((a, r) => a + r.y + r.h / 2, 0) / all.length;
      for (const n of picked) pos.set(n.id, { x: n.x, y: Math.round(c - rects.get(n.id)!.h / 2) });
    }
    if (mode === 'hspace' || mode === 'vspace') {
      const h = mode === 'hspace';
      const sorted = [...picked].sort((a, b) => (h ? a.x - b.x : a.y - b.y));
      const size = (n: Node): number => (h ? rects.get(n.id)!.w : rects.get(n.id)!.h);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = (h ? last.x - first.x : last.y - first.y) + size(last);
      const gap = (span - sorted.reduce((a, n) => a + size(n), 0)) / (sorted.length - 1);
      let at = h ? first.x : first.y;
      for (const n of sorted) {
        pos.set(n.id, h ? { x: Math.round(at), y: n.y } : { x: n.x, y: Math.round(at) });
        at += size(n) + gap;
      }
    }
    s.mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (pos.has(n.id) ? { ...n, ...pos.get(n.id)! } : n)) }));
  }

  /** Stop without saving; callers that need a final save await flushBeforeClose first. */
  function dispose(): void {
    if (!active()) return;
    commitOperation();
    disposed = true;
    generation++;
    loading = undefined;
    operations.clear();
    unwatch?.();
    cleanups.splice(0).forEach((stop) => stop());
    [settleTimer, noticeTimer, pushTimer, projectTimer].forEach(clearTimeout);
    save.stop();
    target.close();
    target = localTarget;
    backend = null;
    clipboard = null;
    edits.clear();
  }

  return { useStore, boot, openCollab, dispose, onOperation, boardLoading, saveNow, flushBeforeClose, deletedBoards, restoreBoard, loadState, currentBoard, showRect, reveal, centerOn, say, loadBoards, storeImage, copySelection, duplicateInPlace, duplicateSelection, pasteClipboard, restack, align };
}

/** The page's editor. */
export const defaultSession = createEditSession({ page: true });
export const { useStore, boot, openCollab, boardLoading, saveNow, flushBeforeClose, deletedBoards, restoreBoard, loadState, currentBoard, showRect, reveal, centerOn, say, loadBoards, storeImage, copySelection, duplicateInPlace, duplicateSelection, pasteClipboard, restack, align } = defaultSession;

/** What the board of a state takes (see Target.takes), without telling the user anything. */
export const takesIn = (s: Pick<State, 'collab'>): ((what: EditKind) => boolean) => s.collab?.takes ?? takesAll;
/** What the board on screen takes: the screen does not offer the rest (hidden or disabled rather than turned away when used). */
export const useTakes = (): ((what: EditKind) => boolean) => useStore(takesIn);
