import { type Connection, type Hocuspocus, Server } from '@hocuspocus/server';
import { messageYjsSyncStep1 } from 'y-protocols/sync';
import * as Y from 'yjs';
import { type Answer, type LetGo, type Role, readCommit, readCredential, writeAccess, writeAnswer, writeLetGo } from '../../src/collab/protocol';
import { type Denial, authenticate, authorize } from './access';
import type { CollabStore } from './store';

/**
 * A refusal the provider receives as the reason of its authenticationFailed event. Its message is
 * left empty: Hocuspocus logs a hook's error with its stack whenever it has one.
 */
function refusal(documentName: string, reason: Denial | 'schema' | 'not-initialized'): Error & { reason: string } {
  console.warn(`[keito-collab] ${documentName}: connection refused (${reason})`);
  return Object.assign(new Error(), { reason });
}

/** What a connection was let in by (see onAuthenticate): the invite, checked again on each commit and every WATCH_MS, and its role. */
interface Admitted {
  invite: string;
  role: Role;
}
const admitted = (connection: Connection): Admitted => connection.context as Admitted;

/** How often the open projects are looked up for a delete or a revoke made by another process (the administration commands). */
const WATCH_MS = 1_000;

/** Why a client is let go for a denial of its access ('read-only' is no reason to let one go). */
// A grant is never taken out of the store: what else ends one's access is its revoke.
const letGoFor = (denial: Denial): LetGo => (denial === 'deleted' ? 'deleted' : 'revoked');

/** Tell a client why it is let go, and close its connection. */
function letGo(connection: Connection, why: LetGo): void {
  console.warn(`[keito-collab] ${connection.document.name}: ${why}, client of invite ${admitted(connection).invite} let go`);
  connection.sendStateless(writeLetGo(why));
  connection.close();
}

/**
 * Let go of every client of an open project whose invite no longer lets it see the project (revoked,
 * or the project deleted by another process), looked up every WATCH_MS. Returns what stops the watch.
 */
function watchAccess(hocuspocus: Hocuspocus, store: CollabStore): () => void {
  const timer = setInterval(() => {
    for (const document of hocuspocus.documents.values()) {
      for (const connection of document.getConnections()) {
        const access = authorize(store, admitted(connection).invite, document.name, 'view');
        if (!access.ok) letGo(connection, letGoFor(access.denial));
      }
    }
  }, WATCH_MS);
  return () => clearInterval(timer);
}

/**
 * The collaboration server: Hocuspocus over the store. A connection is let in to one project by an
 * invite for that project (the project id alone is not enough; see access.ts), only while the invite
 * is not revoked and the project not deleted, and only a client of the project's schema. Edits reach
 * the project only as commits of an editor (see src/collab/protocol.ts), answered once stored. A
 * client whose invite is revoked, or whose project is deleted, while connected is let go (see
 * watchAccess).
 */
export function collabServer(store: CollabStore, options: { port: number; address?: string }): Server {
  let unwatch = (): void => {};
  const server: Server = new Server({
    port: options.port,
    address: options.address,
    quiet: true,
    // The process stops on SIGINT/SIGTERM after storing what it holds (see cli.ts).
    stopOnSignals: false,

    async onAuthenticate({ token, documentName, connectionConfig }): Promise<Admitted> {
      const credential = readCredential(token);
      const access = authorize(store, credential && authenticate(store, credential.token), documentName, 'view');
      if (!access.ok) throw refusal(documentName, access.denial);
      if (credential?.schema !== store.projectSchema(documentName)) throw refusal(documentName, 'schema');
      // Read-only for Yjs's own sync: an edit it carried would be in the project before it is stored.
      connectionConfig.readOnly = true;
      return { invite: access.invite, role: access.role };
    },

    async beforeSync({ connection, type }) {
      // Ahead of the answer to the client's sync: it knows what it may do by the time it has the project.
      if (type === messageYjsSyncStep1) connection.sendStateless(writeAccess(admitted(connection).role));
    },

    async onLoadDocument({ documentName }) {
      const state = store.load(documentName);
      if (!state) throw refusal(documentName, 'not-initialized');
      return state;
    },

    async onStateless({ connection, document, documentName, payload }) {
      const commit = readCommit(payload);
      if (!commit) return;
      const answer = (a: Answer): void => connection.sendStateless(writeAnswer(a));
      const probe = new Y.Doc();
      try {
        // Read on a document of its own, not the project's: the project's takes only what is stored.
        Y.applyUpdate(probe, commit.update);
      } catch {
        return answer({ type: 'refused', op: commit.op, reason: 'malformed' });
      } finally {
        probe.destroy();
      }
      let stored;
      try {
        // Checked as the edit is stored, not as the client was let in: an invite revoked since lets nothing more in.
        stored = store.commit(documentName, commit.op, commit.update, () => {
          const access = authorize(store, admitted(connection).invite, documentName, 'edit');
          return access.ok ? null : access.denial;
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[keito-collab] ${documentName}: edit ${commit.op} not stored: ${reason}`);
        return answer({ type: 'failed', op: commit.op, reason });
      }
      if (stored === 'read-only') return answer({ type: 'refused', op: commit.op, reason: stored });
      if (stored === 'deleted') return document.getConnections().forEach((c) => letGo(c, 'deleted'));
      if (stored !== 'stored' && stored !== 'known') return letGo(connection, letGoFor(stored));
      // Not applied before it is stored: another editor would see it, and an edit made over it
      // would be stored without it, which the project could not take in after a restart.
      Y.applyUpdate(document, commit.update, { source: 'local' });
      answer({ type: 'saved', op: commit.op });
    },

    async onStoreDocument({ documentName, document }) {
      store.compact(documentName, Y.encodeStateAsUpdate(document));
    },

    async onListen() {
      unwatch = watchAccess(server.hocuspocus, store);
    },

    async onDestroy() {
      unwatch();
    },
  });
  return server;
}
