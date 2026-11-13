import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { type ProjectSeed, SCHEMA, seedProject } from '../../src/collab/model';
import type { Role } from '../../src/collab/protocol';
import type { Doc } from '../../src/model/types';

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const roleOf = (stored: unknown): Role => (stored === 'viewer' ? 'viewer' : 'editor');

/**
 * The collaboration server's SQLite file. A project's Yjs state is the binary as last compacted plus
 * the edits stored since, each under the op id it was committed with. A project exists only once it
 * has been initialized (`initProject`): an empty or unknown document is never taken for a new one.
 * A deleted project keeps its row and its state, marked `deleted_at`, until it is restored.
 * A grant is an invite to one project, with its role: it keeps only the hash of its secret, and stays,
 * marked `revoked_at`, once revoked.
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
      created_at TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      revoked_at TEXT
    );
  `);

  // CREATE TABLE IF NOT EXISTS leaves a table made before a column was added without it.
  const addColumn = (table: string, column: string, type: string): void => {
    if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('projects', 'deleted_at', 'TEXT');
  // Grants made before there were viewers were editors'.
  addColumn('grants', 'role', "TEXT NOT NULL DEFAULT 'editor'");
  addColumn('grants', 'revoked_at', 'TEXT');

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
    addGrant: db.prepare('INSERT INTO grants (id, project, token_hash, created_at, role) VALUES (?, ?, ?, ?, ?)'),
    grantOf: db.prepare('SELECT id FROM grants WHERE token_hash = ?'),
    grant: db.prepare('SELECT project, role, revoked_at FROM grants WHERE id = ?'),
    grants: db.prepare('SELECT id, role, created_at, revoked_at FROM grants WHERE project = ? ORDER BY created_at, id'),
    revoke: db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
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

    /** A new invite to a project (an editor's unless `role` says); the secret is returned this once and kept only as a hash. */
    addGrant(project: string, role: Role = 'editor'): { id: string; token: string } {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      sql.addGrant.run(id, project, digest(token), now(), role);
      return { id, token };
    },

    /** The id of the grant whose secret this is, revoked or not; null for none. */
    grantOf(token: string): string | null {
      const row = sql.grantOf.get(digest(token));
      return row ? String(row.id) : null;
    },

    /** A grant as it stands now; null for none of that id. */
    grant(id: string): { project: string; role: Role; revoked: boolean } | null {
      const row = sql.grant.get(id);
      return row ? { project: String(row.project), role: roleOf(row.role), revoked: !!row.revoked_at } : null;
    },

    /** A project's grants, oldest first, the revoked ones included. */
    grants(project: string): { id: string; role: Role; created: string; revoked: string | null }[] {
      return sql.grants.all(project).map((r) => ({ id: String(r.id), role: roleOf(r.role), created: String(r.created_at), revoked: r.revoked_at ? String(r.revoked_at) : null }));
    },

    /** Revoke a grant for good: its secret no longer lets anyone in. False when there is no such grant not yet revoked. */
    revokeGrant(id: string): boolean {
      return sql.revoke.run(now(), id).changes > 0;
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

    /**
     * Store a committed edit once: 'known' when this op id was stored before, 'deleted' (not stored) for
     * a deleted project. `refusal`, run in the same transaction as the write (no revoke comes between),
     * says why the edit may not be stored, if it may not: it is then returned, and nothing stored.
     */
    commit<R extends string>(project: string, op: string, update: Uint8Array, refusal: () => R | null = () => null): 'stored' | 'known' | 'deleted' | R {
      return inTransaction(() => {
        const refused = refusal();
        if (refused) return refused;
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
