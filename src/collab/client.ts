import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { uuid } from '../model/ids';
import type { BoardKind } from '../model/kinds';
import type { Doc } from '../model/types';
import { type SharedBoardInfo, addBoard, boardList, boardNodes, deleteBoard, deletedBoardList, renameBoard, restoreBoard } from './boards';
import type { NodeEdit } from './edits';
import { SCHEMA, boardDoc, projectTitle, renameProject } from './model';
import { writeEdit } from './nodes';
import { type Refusal, readAnswer, readDeleted, writeCommit, writeCredential } from './protocol';

/** Where a shared project is, and the credential that lets this client in. */
export interface SharedJoin {
  /** The collaboration server, ws:// or wss://. */
  server: string;
  project: string;
  token: string;
}

/**
 * Why the link is 'refused': a refusal of the server (see protocol.ts; `deleted` also while connected),
 * or `unreachable`, no server answered.
 */
export type LinkRefusal = Refusal | 'unreachable';

/**
 * How this client stands with the server. `pending`: edits made here and not yet confirmed stored;
 * `failure`: why the last store failed (they are sent again); `refusal`: why the link is 'refused'.
 */
export interface ShareStatus {
  link: 'connecting' | 'online' | 'offline' | 'refused';
  pending: number;
  failure: string | null;
  refusal: LinkRefusal | null;
}

/** What the user is told when the project cannot be opened (or is left), by the reason it was turned away. */
const REFUSALS: Record<LinkRefusal, string> = {
  deleted: 'この共有案件は削除されています',
  schema: 'この版の keito では開けない共有案件です',
  unreachable: '共同編集先に接続できません（サーバーが動いているか、参加リンクのアドレスが正しいかを確かめてください）',
  'no-access': '共有案件に接続できません（参加の権限がないか、案件がありません）',
};
// A reason this version does not know (an older or newer server's) is told as the general one.
const refusalOf = (reason: string): LinkRefusal => (Object.hasOwn(REFUSALS, reason) ? (reason as LinkRefusal) : 'no-access');

/** A Yjs update failing to store is tried again after these waits, the last one repeated. */
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];

/** How far this client can go back and forth through its own edits of a board. */
export interface Steps {
  undo: boolean;
  redo: boolean;
}

/**
 * A connection to one shared project. Edits are made through it (`edit`, `undo`, `redo`) and kept
 * until the server confirms them stored; an edit that fails to store is sent again, under the same
 * op id, until it is. Updates from others change the Y.Doc and are heard through `listen`; they are
 * never sent back as edits of this client, nor undone by it.
 */
export function joinProject(join: SharedJoin) {
  const ydoc = new Y.Doc();
  /** This page's own edits of the drawing: what its undo takes back. */
  const drawing = Symbol('drawing edit');
  /** Board and project management: committed like the drawing's edits, under an origin of its own so that undoing the drawing never takes it back. */
  const manage = Symbol('board management');
  /** Per board, what this client did there, to be undone: its own drawing edits, nothing else. */
  const histories = new Map<string, Y.UndoManager>();
  const pending = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();
  const status: Omit<ShareStatus, 'pending'> = { link: 'connecting', failure: null, refusal: null };
  let closed = false;
  let joined = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;

  const notify = (): void => listeners.forEach((hear) => hear());

  let settle: { resolve: () => void; reject: (e: Error) => void };
  const ready = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nobody may be waiting on it (a connection closed before it synced).
  ready.catch(() => {});

  const provider = new HocuspocusProvider({
    url: join.server,
    name: join.project,
    document: ydoc,
    token: writeCredential({ token: join.token, schema: SCHEMA }),
    onStatus: ({ status: s }) => {
      if (closed || status.link === 'refused') return;
      // Not waited out: the provider would try again for ever, and the page waits on `ready` to show a board.
      if (s === WebSocketStatus.Disconnected && !joined) return refuse('unreachable');
      status.link = s === WebSocketStatus.Connected ? (provider.isSynced ? 'online' : 'connecting') : s === WebSocketStatus.Connecting ? 'connecting' : 'offline';
      notify();
    },
    onSynced: ({ state }) => {
      if (closed || !state || status.link === 'refused') return;
      status.link = 'online';
      joined = true;
      settle.resolve();
      sendAll();
      notify();
    },
    onAuthenticationFailed: ({ reason }) => refuse(reason),
    onStateless: ({ payload }) => {
      if (readDeleted(payload)) return refuse('deleted');
      const answer = readAnswer(payload);
      if (closed || !answer || !pending.has(answer.op)) return;
      if (answer.type === 'saved') {
        pending.delete(answer.op);
        if (!pending.size) {
          status.failure = null;
          retries = 0;
        }
      } else {
        status.failure = answer.reason;
        if (answer.type === 'failed') retryLater();
      }
      notify();
    },
  });

  function refuse(reason: string): void {
    if (closed || status.link === 'refused') return;
    status.link = 'refused';
    status.refusal = refusalOf(reason);
    settle.reject(new Error(REFUSALS[status.refusal]));
    provider.destroy();
    notify();
  }

  /** Whether this client still edits the project: not closed, nor turned away (an edit then could never be stored). */
  const editing = (): boolean => !closed && status.link !== 'refused';

  function send(op: string, update: Uint8Array): void {
    if (!closed && status.link === 'online') provider.sendStateless(writeCommit(op, update));
  }

  /** Send every unconfirmed edit again, oldest first (the server stores each op id once). */
  function sendAll(): void {
    clearTimeout(retryTimer);
    for (const [op, update] of pending) send(op, update);
  }

  function retryLater(): void {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(sendAll, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
  }

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === drawing || origin === manage || origin instanceof Y.UndoManager) {
      const op = uuid();
      pending.set(op, update);
      send(op, update);
    }
    notify();
  });

  /** A board's nodes, with their history begun before the first edit here so that the edit is in it. */
  function tracked(board: string): { nodes: Y.Map<unknown>; history: Y.UndoManager } | null {
    const nodes = boardNodes(ydoc, board);
    if (!nodes) return null;
    let history = histories.get(board);
    // Not kept for nodes made anew (the board taken off and put back): it would take back edits of nodes no longer there.
    if (!history || history.scope[0] !== nodes) {
      history?.destroy();
      history = new Y.UndoManager(nodes, { trackedOrigins: new Set([drawing]), captureTimeout: 0 });
      histories.set(board, history);
    }
    return { nodes, history };
  }

  return {
    /**
     * Resolves once the project has been read from the server. Rejects, with what to tell the user, when
     * the server turns the connection away (no grant for the project, another schema) or cannot be reached.
     */
    ready,
    status: (): ShareStatus => ({ ...status, pending: pending.size }),
    title: (): string => projectTitle(ydoc),
    boards: (): SharedBoardInfo[] => boardList(ydoc),
    /** The deleted boards, which `restoreBoard` brings back. */
    deletedBoards: (): SharedBoardInfo[] => deletedBoardList(ydoc),
    /** A board as it is now; null for one deleted, or not in the project. */
    board: (id: string): Doc | null => boardDoc(ydoc, id),
    /** Hear of every change: to the project (here or from others) and to this connection's status. */
    listen(hear: () => void): () => void {
      listeners.add(hear);
      return () => void listeners.delete(hear);
    },
    /** Make an edit of a board: one step to undo, one commit confirmed once stored. */
    edit(board: string, edit: NodeEdit): void {
      const at = editing() ? tracked(board) : null;
      if (at) ydoc.transact(() => writeEdit(at.nodes, edit), drawing);
    },
    /**
     * Take back this client's last edit of a board still to be seen there: what others did since,
     * there or to the same nodes, stays. An edit whose nodes others have taken off is passed over.
     */
    undo(board: string): void {
      if (editing()) tracked(board)?.history.undo();
    },
    redo(board: string): void {
      if (editing()) tracked(board)?.history.redo();
    },
    steps(board: string): Steps {
      const h = editing() ? histories.get(board) : null;
      return { undo: !!h?.canUndo(), redo: !!h?.canRedo() };
    },
    /** Add an empty board to the project; returns its id, or null when no longer editing the project. */
    addBoard(title: string, kind: BoardKind): string | null {
      return editing() ? addBoard(ydoc, { title, kind }, manage) : null;
    },
    renameBoard(id: string, title: string): void {
      if (editing()) renameBoard(ydoc, id, title, manage);
    },
    /** Delete a board for everyone: it stays deleted, whatever is later done on it, until restored. */
    removeBoard(id: string): void {
      if (editing()) deleteBoard(ydoc, id, manage);
    },
    restoreBoard(id: string): void {
      if (editing()) restoreBoard(ydoc, id, manage);
    },
    renameProject(title: string): void {
      if (editing()) renameProject(ydoc, title, manage);
    },
    /** Send unconfirmed edits now rather than at the next retry. */
    retry(): void {
      retries = 0;
      sendAll();
    },
    /** Disconnect for good. Edits not yet confirmed are let go (see `status().pending`). */
    close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      listeners.clear();
      histories.forEach((h) => h.destroy());
      provider.destroy();
      ydoc.destroy();
    },
  };
}

export type SharedProject = ReturnType<typeof joinProject>;
