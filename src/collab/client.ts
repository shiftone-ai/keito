import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { Doc, Pt } from '../model/types';
import { SCHEMA, type SharedBoardInfo, boardDoc, boardList, placeNodes } from './model';
import { readAnswer, writeCommit, writeCredential } from './protocol';

/** Where a shared project is, and the credential that lets this client in. */
export interface SharedJoin {
  /** The collaboration server, ws:// or wss://. */
  server: string;
  project: string;
  token: string;
}

/**
 * How this client stands with the server. `pending`: edits made here and not yet confirmed stored;
 * `failure`: why the last store failed (they are sent again).
 */
export interface ShareStatus {
  link: 'connecting' | 'online' | 'offline' | 'refused';
  pending: number;
  failure: string | null;
}

/** What the user is told when the project cannot be opened, by the reason the server or the connection gave. */
const REFUSALS: Record<string, string> = {
  schema: 'この版の keito では開けない共有案件です',
  unreachable: '共同編集先に接続できません（サーバーが動いているか、参加リンクのアドレスが正しいかを確かめてください）',
};
const NO_ACCESS = '共有案件に接続できません（参加の権限がないか、案件がありません）';

/** A Yjs update failing to store is tried again after these waits, the last one repeated. */
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];

/** An id for an op that stays unique without a secure context (randomUUID needs one; a LAN address is not). */
function opId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * A connection to one shared project. Edits are made through it (`place`) and kept until the server
 * confirms them stored; an edit that fails to store is sent again, under the same op id, until it is.
 * Updates from others change the Y.Doc and are heard through `listen`; they are never sent back as
 * edits of this client.
 */
export function joinProject(join: SharedJoin) {
  const ydoc = new Y.Doc();
  const local = Symbol('local edit');
  const pending = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();
  const status: Omit<ShareStatus, 'pending'> = { link: 'connecting', failure: null };
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
    if (closed) return;
    status.link = 'refused';
    settle.reject(new Error(REFUSALS[reason] ?? NO_ACCESS));
    provider.destroy();
    notify();
  }

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
    if (origin === local) {
      const op = opId();
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
    boards: (): SharedBoardInfo[] => boardList(ydoc),
    board: (id: string): Doc | null => boardDoc(ydoc, id),
    /** Hear of every change: to the project (here or from others) and to this connection's status. */
    listen(hear: () => void): () => void {
      listeners.add(hear);
      return () => void listeners.delete(hear);
    },
    /** Put nodes of a board where they were let go: one edit, confirmed once stored. */
    place(board: string, moves: ReadonlyMap<string, Pt>): void {
      if (!closed && moves.size) placeNodes(ydoc, board, moves, local);
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
