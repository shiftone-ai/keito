import { type Document, type Hocuspocus, Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { type Answer, type Refusal, readCommit, readCredential, writeAnswer, writeDeleted } from '../../src/collab/protocol';
import type { CollabStore } from './store';

/**
 * A refusal the provider receives as the reason of its authenticationFailed event. Its message is
 * left empty: Hocuspocus logs a hook's error with its stack whenever it has one.
 */
function refusal(documentName: string, reason: Refusal | 'not-initialized'): Error & { reason: string } {
  console.warn(`[keito-collab] ${documentName}: connection refused (${reason})`);
  return Object.assign(new Error(), { reason });
}

/** How often the open projects are looked up for a delete made by another process (the administration commands). */
const WATCH_MS = 1_000;

/** Tell every client of a deleted project so, and close their connections. */
function closeDeleted(document: Document): void {
  console.warn(`[keito-collab] ${document.name}: deleted, its clients let go`);
  document.broadcastStateless(writeDeleted());
  for (const connection of document.getConnections()) connection.close();
}

/**
 * Let go of the clients of every open project deleted by another process (`delete` of cli.ts),
 * looked up every WATCH_MS. Returns what stops the watch.
 */
function watchDeleted(hocuspocus: Hocuspocus, store: CollabStore): () => void {
  const timer = setInterval(() => {
    // A project left open with no clients, until Hocuspocus unloads it, has nobody to tell.
    for (const document of hocuspocus.documents.values()) if (document.getConnectionsCount() && store.isDeleted(document.name)) closeDeleted(document);
  }, WATCH_MS);
  return () => clearInterval(timer);
}

/**
 * The collaboration server: Hocuspocus over the store. A connection is let in to one project by a
 * grant for that project (the project id alone is not enough), only while the project is not
 * deleted, and only a client of the project's schema. Edits reach the project only as commits (see
 * src/collab/protocol.ts), answered once stored. A project deleted while open has its clients let go
 * (see watchDeleted).
 */
export function collabServer(store: CollabStore, options: { port: number; address?: string }): Server {
  let unwatch = (): void => {};
  const server: Server = new Server({
    port: options.port,
    address: options.address,
    quiet: true,
    // The process stops on SIGINT/SIGTERM after storing what it holds (see cli.ts).
    stopOnSignals: false,

    async onAuthenticate({ token, documentName, connectionConfig }) {
      const credential = readCredential(token);
      const schema = store.projectSchema(documentName);
      if (!credential || schema === null || store.grantedProject(credential.token) !== documentName) throw refusal(documentName, 'no-access');
      // Told only to a holder of a grant for the project.
      if (store.isDeleted(documentName)) throw refusal(documentName, 'deleted');
      if (credential.schema !== schema) throw refusal(documentName, 'schema');
      // Read-only for Yjs's own sync: an edit it carried would be in the project before it is stored.
      connectionConfig.readOnly = true;
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
      try {
        if (store.commit(documentName, commit.op, commit.update) === 'deleted') return closeDeleted(document);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[keito-collab] ${documentName}: edit ${commit.op} not stored: ${reason}`);
        return answer({ type: 'failed', op: commit.op, reason });
      }
      // Not applied before it is stored: another editor would see it, and an edit made over it
      // would be stored without it, which the project could not take in after a restart.
      Y.applyUpdate(document, commit.update, { source: 'local' });
      answer({ type: 'saved', op: commit.op });
    },

    async onStoreDocument({ documentName, document }) {
      store.compact(documentName, Y.encodeStateAsUpdate(document));
    },

    async onListen() {
      unwatch = watchDeleted(server.hocuspocus, store);
    },

    async onDestroy() {
      unwatch();
    },
  });
  return server;
}
