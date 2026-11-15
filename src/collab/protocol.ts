/**
 * What an editor and the collaboration server say to each other beside Yjs's own sync, as stateless
 * messages. Edits reach the project only this way, and are confirmed only once the server has stored
 * them: the server takes no edit from Yjs's own sync, which holds it in memory that a crash loses.
 *
 * The client sends each of its edits (one Yjs transaction) as a `commit` under an id of its own and
 * keeps it until the server answers. The server stores the edit, then answers `saved`; a commit it
 * has already stored is answered `saved` again without being stored twice. `failed` says the store
 * failed (the client sends it again later); `refused` says the edit cannot be read.
 *
 * The server tells every client of a project when the project is deleted (`deleted`), and the clients
 * of an invite when it is revoked (`revoked`), answering an edit sent to it or unasked: the edit is
 * not stored, and the client leaves the project, as it would on being turned away for that reason
 * when connecting.
 *
 * Once it lets a client in, the server tells it what its invite lets it do (`access`), before it
 * answers the client's first sync: a viewer's commits are refused (`read-only`).
 *
 * The server tells the clients of a project of each picture it newly keeps for it (`picture`, see
 * pictureRef.ts): one waiting for it fetches it then.
 */
export interface Commit {
  type: 'commit';
  op: string;
  update: Uint8Array;
}
export type Answer = { type: 'saved'; op: string } | { type: 'failed'; op: string; reason: string } | { type: 'refused'; op: string; reason: string };

/**
 * Why the server turns a client away, sent as the reason of the provider's authenticationFailed event:
 * `deleted`, the project has been deleted; `revoked`, the client's invite has been revoked; `schema`,
 * the project is of a form the client does not read; `no-access`, anything else (no invite for the
 * project, or no such project: a client without an invite is not told which).
 */
export type Refusal = 'deleted' | 'revoked' | 'schema' | 'no-access';

/** What an invite lets its holder do with its project: see it as it changes, or edit it too. */
export type Role = 'viewer' | 'editor';
export const isRole = (v: unknown): v is Role => v === 'viewer' || v === 'editor';

/** Why the server lets go of a client while it is connected. */
export type LetGo = Extract<Refusal, 'deleted' | 'revoked'>;

/** What a client presents on connecting: the invite's secret, and the schema it reads and writes. */
export interface Credential {
  token: string;
  schema: number;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const writeCommit = (op: string, update: Uint8Array): string => JSON.stringify({ type: 'commit', op, update: toBase64(update) });

/** A commit as sent, or null for anything else (or anything malformed). */
export function readCommit(text: string): Commit | null {
  const v = parse(text);
  if (v?.type !== 'commit' || typeof v.op !== 'string' || !v.op || typeof v.update !== 'string') return null;
  try {
    return { type: 'commit', op: v.op, update: fromBase64(v.update) };
  } catch {
    return null;
  }
}

export const writeAnswer = (answer: Answer): string => JSON.stringify(answer);

export function readAnswer(text: string): Answer | null {
  const v = parse(text);
  if (typeof v?.op !== 'string') return null;
  if (v.type === 'saved') return { type: 'saved', op: v.op };
  if ((v.type === 'failed' || v.type === 'refused') && typeof v.reason === 'string') return { type: v.type, op: v.op, reason: v.reason };
  return null;
}

export const writeLetGo = (why: LetGo): string => JSON.stringify({ type: why });

/** Why a message from the server lets go of this client, or null for a message that does not. */
export function readLetGo(text: string): LetGo | null {
  const type = parse(text)?.type;
  return type === 'deleted' || type === 'revoked' ? type : null;
}

export const writeAccess = (role: Role): string => JSON.stringify({ type: 'access', role });

/** The role a message from the server says this client was let in with, or null for any other message. */
export function readAccess(text: string): Role | null {
  const v = parse(text);
  return v?.type === 'access' && isRole(v.role) ? v.role : null;
}

export const writeCredential = (credential: Credential): string => JSON.stringify(credential);

export function readCredential(text: string): Credential | null {
  const v = parse(text);
  return typeof v?.token === 'string' && typeof v.schema === 'number' ? { token: v.token, schema: v.schema } : null;
}

export const writeArrival = (name: string): string => JSON.stringify({ type: 'picture', name });

/** The name of the picture a message from the server says it now keeps, or null for any other message. */
export function readArrival(text: string): string | null {
  const v = parse(text);
  return v?.type === 'picture' && typeof v.name === 'string' ? v.name : null;
}
