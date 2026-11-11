import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { BoardKind } from '../model/kinds';
import type { Doc, Pt } from '../model/types';
import { SCHEMA, type SharedBoardInfo, addBoard, boardDoc, boardList, deleteBoard, deletedBoardList, placeNodes, projectTitle, renameBoard, renameProject, restoreBoard, uniqueId } from './model';
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

/**
 * A connection to one shared project. Edits are made through it (`place`) and kept until the server
 * confirms them stored; an edit that fails to store is sent again, under the same op id, until it is.
 * Updates from others change the Y.Doc and are heard through `listen`; they are never sent back as
 * edits of this client.
 */
export function joinProject(join: SharedJoin) {
  const ydoc = new Y.Doc();
  const local = Symbol('local edit');
  /** Board and project management: committed like the drawing's edits, under an origin of its own so that undoing the drawing never takes it back. */
  const manage = Symbol('board management');
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
    if (origin === local || origin === manage) {
      const op = uniqueId();
      pending.set(op, update);
      send(op, update);
    }
    notify();
  });

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
    /** Put nodes of a board where they were let go: one edit, confirmed once stored. */
    place(board: string, moves: ReadonlyMap<string, Pt>): void {
      if (editing() && moves.size) placeNodes(ydoc, board, moves, local);
    },
    /** Add an empty board to the project; returns its id, or null when no longer editing the project. */
    addBoard(title: string, kind: BoardKind): string | null {
      if (!editing()) return null;
      const id = uniqueId();
      addBoard(ydoc, { id, title, kind }, manage);
      return id;
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
      provider.destroy();
      ydoc.destroy();
    },
  };
}

export type SharedProject = ReturnType<typeof joinProject>;
