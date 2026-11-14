import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { uuid } from '../model/ids';
import type { BoardKind } from '../model/kinds';
import type { Doc } from '../model/types';
import { type SharedBoardInfo, addBoard, boardLines, boardList, boardNodes, deleteBoard, deletedBoardList, renameBoard, restoreBoard } from './boards';
import type { BoardEdit } from './edits';
import { type DeviceState, type DeviceStore, type KeptProject, keepCopy } from './kept';
import { type BoardParts, SCHEMA, boardDoc, projectTitle, renameProject, writeEdit } from './model';
import { type Role, readAccess, readAnswer, readLetGo, writeCommit, writeCredential } from './protocol';
import { type LinkRefusal, refusalOf, refusalText } from './refusals';

/** Where a shared project is, and the credential that lets this client in. */
export interface SharedJoin {
  /** The collaboration server, ws:// or wss://. */
  server: string;
  project: string;
  token: string;
}

/**
 * How this client stands with the server. `role`: what the server let this client in to do, null until
 * it has said (the project opened from the copy kept on this device, offline); `pending`: edits made
 * here and not yet confirmed stored (once 'refused', never to be); `failure`: why the last store
 * failed (they are sent again); `refusal`: why the link is 'refused'. `device`: whether the project
 * is kept on this device as this page holds it (see kept.ts), and `deviceFailure`, why not while it
 * is 'failed'.
 */
export interface ShareStatus {
  link: 'connecting' | 'online' | 'offline' | 'refused';
  role: Role | null;
  pending: number;
  failure: string | null;
  refusal: LinkRefusal | null;
  device: DeviceState;
  deviceFailure: string | null;
}

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
 *
 * The project is kept on `device` as it changes, its unconfirmed edits included (see kept.ts). A
 * project kept there, which the server last let this device edit, opens from there before the server
 * answers, or without it while offline; its unconfirmed edits are sent once the server has let this
 * client in again as an editor. Turned away (by the server, now or when last asked) with edits not
 * sent, the project stays as this device holds it, 'refused', never sending them, until `discard`:
 * the user takes them out or lets them go. Any other project opens only from the server.
 */
export function joinProject(join: SharedJoin, device: DeviceStore | null = null) {
  const ydoc = new Y.Doc();
  /** This page's own edits of the drawing: what its undo takes back. */
  const drawing = Symbol('drawing edit');
  /** Board and project management: committed like the drawing's edits, under an origin of its own so that undoing the drawing never takes it back. */
  const manage = Symbol('board management');
  /** Per board, what this client did there, to be undone: its own drawing edits, nothing else. */
  const histories = new Map<string, Y.UndoManager>();
  const pending = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();
  const status: Pick<ShareStatus, 'link' | 'role' | 'failure' | 'refusal'> = { link: 'connecting', role: null, failure: null, refusal: null };
  let closed = false;
  /** Whether the project is on screen: read from the server, or from the copy kept on this device. */
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

  /**
   * The copy kept on this device, one per project, schema and server: a link to the project on
   * another server (an id is no secret) neither opens it nor sends its edits there. Another schema's
   * or server's is a copy of its own, left as it is.
   */
  const copy = keepCopy(device, `${join.project}/${SCHEMA}@${join.server}`, () => ({ state: Y.encodeStateAsUpdate(ydoc), pending: new Map(pending) }), notify);
  /** The copy kept here, as it is put in the Y.Doc: not an edit of this client, nor a change to keep. */
  const fromDevice = Symbol('kept on this device');
  let provider: HocuspocusProvider | null = null;

  /** Put a copy kept on this device in the Y.Doc, its unconfirmed edits with it. */
  function takeIn(kept: KeptProject): void {
    Y.transact(ydoc, () => {
      Y.applyUpdate(ydoc, kept.state);
      for (const [op, update] of kept.pending) {
        pending.set(op, update);
        Y.applyUpdate(ydoc, update);
      }
    }, fromDevice);
  }

  async function start(): Promise<void> {
    const kept = await copy.load();
    if (closed) return;
    if (kept) {
      takeIn(kept);
      joined = true;
      // Not asked again: the server let nothing of it in, and answering now it would not say what to do with the edits it turned away.
      if (!kept.editable) [status.link, status.refusal] = ['refused', kept.refusal ?? 'no-access'];
      settle.resolve();
      notify();
      if (!kept.editable) return;
    }
    provider = connect();
  }

  const connect = (): HocuspocusProvider => new HocuspocusProvider({
    url: join.server,
    name: join.project,
    document: ydoc,
    token: writeCredential({ token: join.token, schema: SCHEMA }),
    onStatus: ({ status: s }) => {
      if (closed || status.link === 'refused') return;
      // Not waited out: the provider would try again for ever, and the page waits on `ready` to show a board.
      if (s === WebSocketStatus.Disconnected && !joined) return refuse('unreachable');
      status.link = s === WebSocketStatus.Connected ? (provider?.isSynced ? 'online' : 'connecting') : s === WebSocketStatus.Connecting ? 'connecting' : 'offline';
      notify();
    },
    onSynced: ({ state }) => {
      if (closed || !state || status.link === 'refused') return;
      status.link = 'online';
      joined = true;
      settle.resolve();
      sendAll();
      copy.changed();
      notify();
    },
    onAuthenticationFailed: ({ reason }) => refuse(reason),
    onStateless: ({ payload }) => {
      const gone = readLetGo(payload);
      if (gone) return refuse(gone);
      const role = readAccess(payload);
      if (role) return admit(role);
      const answer = readAnswer(payload);
      if (closed || !answer || !pending.has(answer.op)) return;
      // Not kept to send again: the server would turn it away each time.
      if (answer.type === 'refused') return refuse(answer.reason);
      if (answer.type === 'saved') {
        pending.delete(answer.op);
        copy.confirmed(answer.op);
        if (!pending.size) {
          status.failure = null;
          retries = 0;
        }
      } else {
        status.failure = answer.reason;
        retryLater();
      }
      notify();
    },
  });

  function refuse(reason: string): void {
    if (closed || status.link === 'refused') return;
    status.link = 'refused';
    status.refusal = refusalOf(reason);
    settle.reject(new Error(refusalText(status.refusal)));
    clearTimeout(retryTimer);
    provider?.destroy();
    // Not before the project is on screen: this page holds nothing of it.
    if (joined) {
      copy.refused(status.refusal);
      // Not left on the device only: another page of the project here may have kept edits this page never held, and taking out or letting go of the copy takes theirs with it.
      void copy.settled().then((kept) => {
        if (!kept || closed) return;
        takeIn(kept);
        notify();
      });
    }
    notify();
  }

  /**
   * The server let this client in with `role`. A viewer's copy kept on this device is kept as one the
   * server turned away (see kept.ts): it does not open as editable again, and its unconfirmed edits,
   * made while the server let this device edit, are never sent under the viewer's invite. Holding
   * such edits, the client is turned away 'read-only': they stay on screen, to be taken out.
   */
  function admit(role: Role): void {
    if (closed || status.role === role) return;
    status.role = role;
    if (role === 'viewer' && pending.size) return refuse('read-only');
    if (role === 'viewer') copy.refused('read-only');
    notify();
  }

  /**
   * Whether this client still edits the project: not closed, nor turned away, nor let in as a viewer
   * (an edit then could never be stored).
   */
  const editing = (): boolean => !closed && status.link !== 'refused' && status.role !== 'viewer';

  function send(op: string, update: Uint8Array): void {
    // Not while the role is unknown: an edit kept on this device goes out only once the server has said, on this connection, that this client edits.
    if (!closed && status.link === 'online' && status.role === 'editor') provider?.sendStateless(writeCommit(op, update));
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
    if (joined && origin !== fromDevice) copy.changed();
    notify();
  });

  /** What a board holds, with its history begun before the first edit here so that the edit is in it. */
  function tracked(board: string): (BoardParts & { history: Y.UndoManager }) | null {
    const nodes = boardNodes(ydoc, board);
    const lines = boardLines(ydoc, board);
    if (!nodes || !lines) return null;
    let history = histories.get(board);
    // Not kept for nodes or lines made anew (the board taken off and put back): it would take back edits of ones no longer there.
    if (!history || history.scope[0] !== nodes || history.scope[1] !== lines) {
      history?.destroy();
      // Not grouped by how soon edits follow each other: each is a step of its own unless it joins the last (see edit).
      history = new Y.UndoManager([nodes, lines], { trackedOrigins: new Set([drawing]), captureTimeout: Infinity });
      histories.set(board, history);
    }
    return { nodes, lines, history };
  }

  void start();

  return {
    /**
     * Resolves once the project has been read from the server, or from the copy kept on this device
     * (see joinProject). Rejects, with what to tell the user, when the server turns the connection away
     * (no grant for the project, another schema) or cannot be reached before then.
     */
    ready,
    status: (): ShareStatus => ({ ...status, pending: pending.size, device: copy.state(), deviceFailure: copy.failure() }),
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
    /** Make an edit of a board: one commit confirmed once stored, and a step to undo of its own or, `joins`, part of this client's last. */
    edit(board: string, edit: BoardEdit, joins = false): void {
      const at = editing() ? tracked(board) : null;
      if (!at) return;
      if (!joins) at.history.stopCapturing();
      ydoc.transact(() => writeEdit(at, edit), drawing);
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
    /**
     * Take the copy the server turned away off this device: its unsent edits have been taken out, or
     * the user lets them go. This page keeps nothing of the project after.
     */
    discard: (): Promise<void> => copy.discard(),
    /** Send unconfirmed edits now rather than at the next retry, and keep the project on this device again if that failed. */
    retry(): void {
      retries = 0;
      sendAll();
      copy.changed();
    },
    /**
     * Disconnect for good. Edits not yet confirmed stay in the copy kept on this device (see
     * `status().device`) and are sent the next time the project is opened here; without one they are let go.
     */
    close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      listeners.clear();
      if (joined) copy.stop();
      histories.forEach((h) => h.destroy());
      provider?.destroy();
      ydoc.destroy();
    },
  };
}

export type SharedProject = ReturnType<typeof joinProject>;
