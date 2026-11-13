/**
 * Who may do what with a shared project: the one check every way into a project makes (see
 * server.ts: the document connection, each commit, and every connection open). The subject is the
 * invite a client's secret authenticates, never a name or colour the client shows, nor the project id
 * alone; and it is checked against the store as it is now, so that a revoke or a delete reaches what
 * was let in before.
 */
import type { Refusal, Role } from '../../src/collab/protocol';
import type { CollabStore } from './store';

/** What is asked of a project: to see it (as a connection does), or to change it (as a commit does). */
export type Need = 'view' | 'edit';

const ALLOWED: Record<Role, readonly Need[]> = { viewer: ['view'], editor: ['view', 'edit'] };

/** Why an invite may not do what was asked: as a connection is refused, or `read-only`, a viewer asked to change the project. */
export type Denial = Exclude<Refusal, 'schema'> | 'read-only';

export type Access = { ok: true; invite: string; role: Role } | { ok: false; denial: Denial };

/** The invite a secret authenticates, revoked or not; null for none. The secret is not kept. */
export function authenticate(store: CollabStore, secret: string): string | null {
  return secret ? store.grantOf(secret) : null;
}

/**
 * Whether `invite` may do what `need` asks of `project`. Denied `no-access` without an invite to that
 * project (whoever asks is not told whether it exists), else `revoked`, `deleted` (the project), or
 * `read-only` (a viewer asked to change it).
 */
export function authorize(store: CollabStore, invite: string | null, project: string, need: Need): Access {
  const grant = invite ? store.grant(invite) : null;
  if (!invite || !grant || grant.project !== project) return { ok: false, denial: 'no-access' };
  if (grant.revoked) return { ok: false, denial: 'revoked' };
  if (store.isDeleted(project)) return { ok: false, denial: 'deleted' };
  if (!ALLOWED[grant.role].includes(need)) return { ok: false, denial: 'read-only' };
  return { ok: true, invite, role: grant.role };
}
