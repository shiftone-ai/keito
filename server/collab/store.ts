import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { type ProjectSeed, SCHEMA, seedProject } from '../../src/collab/model';
import type { Doc } from '../../src/model/types';

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * The collaboration server's SQLite file. A project's Yjs state is the binary as last compacted plus
 * the edits stored since, each under the op id it was committed with. A project exists only once it
 * has been initialized (`initProject`): an empty or unknown document is never taken for a new one.
 * A deleted project keeps its row and its state, marked `deleted_at`, until it is restored.
 * Grants keep only the hash of their secret.
 */
export function openStore(file: string) {
  // A write the server waits on is answered within the timeout or fails: the server answers the
  // client `failed`, and the client sends it again.
  const db = new DatabaseSync(file, { timeout: 250 });
  // FULL: an edit answered `saved` survives a power cut, not only a crash of the server.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      schema INTEGER NOT NULL,
      initialized_at TEXT NOT NULL,
      state BLOB NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS updates (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL REFERENCES projects(id),
      data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ops (
      project TEXT NOT NULL REFERENCES projects(id),
      op TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      PRIMARY KEY (project, op)
    );
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(id),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);

  // CREATE TABLE IF NOT EXISTS leaves a table made before projects could be deleted without the column.
  if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('projects', 'deleted_at')) db.exec('ALTER TABLE projects ADD COLUMN deleted_at TEXT');

  function inTransaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const now = (): string => new Date().toISOString();
  /** Whether the project is deleted (false for a project never initialized). */
  const isDeleted = (id: string): boolean => !!sql.deletedAt.get(id)?.deleted_at;
  const sql = {
    addProject: db.prepare('INSERT INTO projects (id, schema, initialized_at, state) VALUES (?, ?, ?, ?)'),
    addGrant: db.prepare('INSERT INTO grants (id, project, token_hash, created_at) VALUES (?, ?, ?, ?)'),
    grant: db.prepare('SELECT project FROM grants WHERE token_hash = ?'),
    schema: db.prepare('SELECT schema FROM projects WHERE id = ?'),
    deletedAt: db.prepare('SELECT deleted_at FROM projects WHERE id = ?'),
    markDeleted: db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    unmarkDeleted: db.prepare('UPDATE projects SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'),
    state: db.prepare('SELECT state FROM projects WHERE id = ?'),
    edits: db.prepare('SELECT data FROM updates WHERE project = ? ORDER BY seq'),
    known: db.prepare('SELECT 1 FROM ops WHERE project = ? AND op = ?'),
    addEdit: db.prepare('INSERT INTO updates (project, data) VALUES (?, ?)'),
    addOp: db.prepare('INSERT INTO ops (project, op, saved_at) VALUES (?, ?, ?)'),
    setState: db.prepare('UPDATE projects SET state = ? WHERE id = ?'),
    dropEdits: db.prepare('DELETE FROM updates WHERE project = ?'),
  };

  return {
    /** Make a new project with one board (a free board unless `kind` says) holding one shape; returns the ids it was given. */
    initProject(input: { title: string; board: string; shape: string; kind?: Doc['kind'] }): ProjectSeed {
      const seed: ProjectSeed = {
        id: randomUUID(),
        title: input.title,
        board: { id: randomUUID(), title: input.board, kind: input.kind },
        shape: { id: randomUUID(), text: input.shape, x: 0, y: 0, w: 160, h: 80 },
      };
      const ydoc = new Y.Doc();
      seedProject(ydoc, seed);
      sql.addProject.run(seed.id, SCHEMA, now(), Y.encodeStateAsUpdate(ydoc));
      return seed;
    },

    /** A new editor's credential for a project; the secret is returned this once and kept only as a hash. */
    addGrant(project: string): { id: string; token: string } {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      sql.addGrant.run(id, project, digest(token), now());
      return { id, token };
    },

    /** The project a credential lets its holder edit, or null for no grant. */
    grantedProject(token: string): string | null {
      const row = sql.grant.get(digest(token));
      return row ? String(row.project) : null;
    },

    /** The schema a project's Yjs state is written in, or null for a project never initialized. */
    projectSchema(id: string): number | null {
      const row = sql.schema.get(id);
      return row ? Number(row.schema) : null;
    },

    isDeleted,

    /**
     * Delete a project: clients are turned away from it, and its edits are no longer stored, until it
     * is restored. False when there is no such project not yet deleted.
     */
    deleteProject(id: string): boolean {
      return sql.markDeleted.run(now(), id).changes > 0;
    },

    /** Bring a deleted project back as it was when deleted. False when there is no such deleted project. */
    restoreProject(id: string): boolean {
      return sql.unmarkDeleted.run(id).changes > 0;
    },

    /** The project's Yjs state as stored, or null for a project never initialized. */
    load(id: string): Uint8Array | null {
      const row = sql.state.get(id);
      if (!row) return null;
      const edits = sql.edits.all(id).map((r) => r.data as Uint8Array);
      return Y.mergeUpdates([row.state as Uint8Array, ...edits]);
    },

    /** Store a committed edit once: 'known' when this op id was stored before, 'deleted' (not stored) for a deleted project. */
    commit(project: string, op: string, update: Uint8Array): 'stored' | 'known' | 'deleted' {
      return inTransaction(() => {
        if (isDeleted(project)) return 'deleted';
        if (sql.known.get(project, op)) return 'known';
        sql.addEdit.run(project, update);
        sql.addOp.run(project, op, now());
        return 'stored';
      });
    },

    /**
     * Replace the stored edits with the whole state they were applied to. `state` must hold every
     * edit stored so far: it is taken from the server's document, to which each edit is applied
     * right after it is stored, with nothing run in between.
     */
    compact(project: string, state: Uint8Array): void {
      inTransaction(() => {
        sql.setState.run(state, project);
        sql.dropEdits.run(project);
      });
    },

    close(): void {
      db.close();
    },
  };
}

export type CollabStore = ReturnType<typeof openStore>;
