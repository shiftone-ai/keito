import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { type Answer, readCommit, readCredential, writeAnswer } from '../../src/collab/protocol';
import type { CollabStore } from './store';

/**
 * A refusal the provider receives as the reason of its authenticationFailed event. Its message is
 * left empty: Hocuspocus logs a hook's error with its stack whenever it has one.
 */
function refusal(documentName: string, reason: string): Error & { reason: string } {
  console.warn(`[keito-collab] ${documentName}: connection refused (${reason})`);
  return Object.assign(new Error(), { reason });
}

/**
 * The collaboration server: Hocuspocus over the store. A connection is let in to one project by a
 * grant for that project (the project id alone is not enough), and only a client of the project's
 * schema. Edits reach the project only as commits (see src/collab/protocol.ts), answered once stored.
 */
export function collabServer(store: CollabStore, options: { port: number; address?: string }): Server {
  return new Server({
    port: options.port,
    address: options.address,
    quiet: true,
    // The process stops on SIGINT/SIGTERM after storing what it holds (see cli.ts).
    stopOnSignals: false,

    async onAuthenticate({ token, documentName, connectionConfig }) {
      const credential = readCredential(token);
      const schema = store.projectSchema(documentName);
      if (!credential || schema === null || store.grantedProject(credential.token) !== documentName) throw refusal(documentName, 'no-access');
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
      try {
        // Applied before it is stored: a malformed update throws here and is never stored, and the
        // document holds every stored edit when it is compacted (see store.compact).
        Y.applyUpdate(document, commit.update, { source: 'local' });
      } catch {
        return answer({ type: 'refused', op: commit.op, reason: 'malformed' });
      }
      try {
        store.commit(documentName, commit.op, commit.update);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[keito-collab] ${documentName}: edit ${commit.op} not stored: ${reason}`);
        return answer({ type: 'failed', op: commit.op, reason });
      }
      answer({ type: 'saved', op: commit.op });
    },

    async onStoreDocument({ documentName, document }) {
      store.compact(documentName, Y.encodeStateAsUpdate(document));
    },
  });
}
