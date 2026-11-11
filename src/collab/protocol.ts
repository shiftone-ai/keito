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
 * The server tells every client of a project when the project is deleted (`deleted`), answering an
 * edit sent to it or unasked: the edit is not stored, and the client leaves the project, as it would
 * on being turned away for that reason when connecting.
 */
export interface Commit {
  type: 'commit';
  op: string;
  update: Uint8Array;
}
export type Answer = { type: 'saved'; op: string } | { type: 'failed'; op: string; reason: string } | { type: 'refused'; op: string; reason: string };

/**
 * Why the server turns a client away, sent as the reason of the provider's authenticationFailed event:
 * `deleted`, the project has been deleted; `schema`, the project is of a form the client does not
 * read; `no-access`, anything else (no grant for the project, or no such project: a client without a
 * grant is not told which).
 */
export type Refusal = 'deleted' | 'schema' | 'no-access';

/** What a client presents on connecting: the grant's secret, and the schema it reads and writes. */
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

export const writeDeleted = (): string => JSON.stringify({ type: 'deleted' });

/** Whether a message from the server says the project has been deleted. */
export const readDeleted = (text: string): boolean => parse(text)?.type === 'deleted';

export const writeCredential = (credential: Credential): string => JSON.stringify(credential);

export function readCredential(text: string): Credential | null {
  const v = parse(text);
  return typeof v?.token === 'string' && typeof v.schema === 'number' ? { token: v.token, schema: v.schema } : null;
}
