import type { Doc } from './types';

/**
 * Boards edited on several machines at once (a shared project's, as shown): an id made for one of
 * them must not depend on what this machine sees, or two people adding at once would make the same.
 */
const sharedBoards = new WeakSet<Doc>();

/** Have ids made for this state of a board (see allIds) unique wherever they are made. */
export function shareIds(doc: Doc): Doc {
  sharedBoards.add(doc);
  return doc;
}

/** The ids taken on a shared board: an id made from them is unique by chance, not by what is here. */
class SharedIds extends Set<string> {}

export const allIds = (doc: Doc): Set<string> => {
  const ids = sharedBoards.has(doc) ? new SharedIds() : new Set<string>();
  for (const n of doc.nodes) {
    ids.add(n.id);
    if (n.type === 'device') for (const p of n.ports) ids.add(`${n.id}/${p.id}`);
  }
  for (const e of doc.edges) ids.add(e.id);
  return ids;
};

/** 128 random bits as a UUID (v4); crypto.randomUUID needs a secure context, which a LAN address is not. */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Short human-readable id (also used as the handle in the YAML text form); on a shared board (see
 * allIds), the prefix and a UUID.
 */
export function freshId(taken: Set<string>, prefix: string): string {
  if (taken instanceof SharedIds) {
    const id = `${prefix}-${uuid()}`;
    taken.add(id);
    return id;
  }
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

export const randomId = (): string => Math.random().toString(36).slice(2, 10);
