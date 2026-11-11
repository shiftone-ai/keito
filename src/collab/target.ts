import { sameBoard, stillIn } from '../model/history';
import type { State, Target } from '../model/store';
import type { Doc, Pt } from '../model/types';
import { ask } from '../platform/io';
import type { SharedProject } from './client';
import { showSharedAddress } from './join';

/** Said when a shared board is asked for an edit it does not take yet. */
const COLLAB_ONLY = '共有中のボードでは、まだ図形の移動しかできません';

/** What the target of a shared board needs of the edit session it is the target of. */
export interface Host {
  get(): State;
  set(change: Partial<State>): void;
  say(text: string): void;
  /** Start an operation on the board as it is (the session's checkpoint). */
  checkpoint(): void;
  /** End the operation under way. */
  commitOperation(): void;
  /** Whether an operation is under way. */
  operating(): boolean;
  /** A board has been put on screen: its address shown, and the board fitted to the window. */
  opened(): void;
}

/**
 * The target of a shared project's board (see openCollab). Its edits are moves of nodes, shown at
 * once and placed in the project when their operation ends; the collaboration server stores them,
 * and `saving` says whether it has. It holds nothing of this machine's store: the board can neither
 * be written there nor take part in what is kept there (history, other boards, pictures).
 */
export function sharedTarget(projectId: string, project: SharedProject, host: Host): Target {
  /** The board of the project on screen (see open). */
  let board = '';
  /** Nodes moved by the operation under way: shown here, placed in the project when it ends. */
  const moved = new Map<string, Pt>();
  const stop = project.listen(refresh);
  const refuse = (): void => host.say(COLLAB_ONLY);

  function status(): Pick<State, 'collab' | 'saving' | 'saveError'> {
    const s = project.status();
    return {
      collab: { ...s, project: projectId, boards: project.boards() },
      saving: s.failure ? 'error' : s.pending ? 'saving' : 'saved',
      saveError: s.failure,
    };
  }

  /** Put the board on screen as the project has it now, with the moves under way here on top. */
  function refresh(): void {
    const s = host.get();
    const fresh = project.board(board);
    const next = fresh && (moved.size ? withMoves(fresh, moved) : fresh);
    const doc = next && !sameBoard(next, s.doc) ? next : s.doc;
    const selection = stillIn(doc, s.selection);
    host.set({ doc, ...(selection.length === s.selection.length ? {} : { selection }), ...status() });
  }

  /** Place the nodes the operation just ended moved, as one edit of the project (sent to be stored). */
  function placeMoved(): void {
    const fresh = project.board(board);
    const moves = new Map(
      [...moved].filter(([node, at]) => {
        const n = fresh?.nodes.find((x) => x.id === node);
        return !!n && (n.x !== at.x || n.y !== at.y);
      }),
    );
    moved.clear();
    if (moves.size) project.place(board, moves);
    else refresh();
  }

  return {
    edit(next, record) {
      const moves = movesBetween(host.get().doc, next);
      if (!moves) return refuse();
      if (!moves.size) return;
      const alone = record || !host.operating();
      if (alone) host.checkpoint();
      for (const [node, at] of moves) moved.set(node, at);
      host.set({ doc: withMoves(host.get().doc, moves) });
      if (alone) host.commitOperation();
    },
    // Not undone by putting back a whole earlier board: that would undo others' edits too.
    begin: () => {},
    end: placeMoved,
    drop() {
      moved.clear();
      refresh();
      host.set({ selection: [], editing: null });
      return true;
    },
    undo: refuse,
    redo: refuse,
    takes(what) {
      if (what === 'select' || what === 'pan') return true;
      refuse();
      return false;
    },
    run: async () => refuse(),
    open(next) {
      if (next === board) return true;
      const doc = project.board(next);
      if (!doc) return false;
      host.commitOperation();
      board = next;
      host.set({ doc, viewing: null, past: [], future: [], selection: [], editing: null, others: [], placing: null, tool: 'select', ...status() });
      host.opened();
      return true;
    },
    remove(gone) {
      if (!project.board(gone)) return false;
      refuse();
      return true;
    },
    keepImage: async (dataUrl) => dataUrl,
    changed: () => {},
    pickUp: () => {},
    readProject: async () => {},
    failed: () => {},
    async flush() {
      host.commitOperation();
      return !project.status().pending;
    },
    async saveNow() {
      host.commitOperation();
      project.retry();
      if (!project.status().pending) host.say('共同編集先に保存済みです（変更は自動で保存されます）');
    },
    async leave() {
      const { pending } = project.status();
      return !pending || ask(`共同編集先にまだ保存されていない変更が ${pending} 件あります。\n切り替えると、この変更は失われます。切り替えますか？`);
    },
    // No undo steps of its own here, and a return to it goes through its project.
    keepSteps: () => {},
    closing: () => project.status().pending > 0,
    gone: () => {},
    address: () => showSharedAddress(projectId),
    close() {
      stop();
      project.close();
    },
  };
}

/** Whether two objects hold the very same values (by reference) under every key but `skip`. */
function sameExcept(a: object, b: object, skip: readonly string[]): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...Object.keys(x), ...Object.keys(y)].every((k) => skip.includes(k) || x[k] === y[k]);
}

/**
 * The nodes `to` puts elsewhere than `from`, or null when `to` changes anything but where nodes are.
 * An edit makes new objects only for what it changes, so all else is compared by reference.
 */
function movesBetween(from: Doc, to: Doc): Map<string, Pt> | null {
  if (to.nodes.length !== from.nodes.length || !sameExcept(from, to, ['nodes'])) return null;
  const moves = new Map<string, Pt>();
  for (const [i, n] of to.nodes.entries()) {
    const was = from.nodes[i];
    if (n === was) continue;
    if (!sameExcept(was, n, ['x', 'y'])) return null;
    if (n.x !== was.x || n.y !== was.y) moves.set(n.id, { x: n.x, y: n.y });
  }
  return moves;
}

const withMoves = (doc: Doc, moves: ReadonlyMap<string, Pt>): Doc => ({ ...doc, nodes: doc.nodes.map((n) => (moves.has(n.id) ? { ...n, ...moves.get(n.id)! } : n)) });
