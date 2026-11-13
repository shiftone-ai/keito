import type { DeviceNode, Doc } from './types';

/**
 * The boards edited on several machines at once (a shared project's), by id: an id made for one of
 * them must not depend on what this machine sees, or two people adding at once would make the same.
 * Held by the board's id, not by a state of it, so that a state made from one shown (a line being
 * planned on it) makes ids the same way.
 */
const sharedBoards = new Set<string>();

/** Have ids made for this board (see allIds and portIds) unique wherever they are made, until the function returned is called. */
export function shareIds(board: string): () => void {
  sharedBoards.add(board);
  return () => sharedBoards.delete(board);
}

/** The ids taken on a shared board: an id made from them is unique by chance, not by what is here. */
class SharedIds extends Set<string> {}

const idsFor = (doc: Doc): Set<string> => (sharedBoards.has(doc.id) ? new SharedIds() : new Set<string>());

export const allIds = (doc: Doc): Set<string> => {
  const ids = idsFor(doc);
  for (const n of doc.nodes) {
    ids.add(n.id);
    if (n.type === 'device') for (const p of n.ports) ids.add(`${n.id}/${p.id}`);
  }
  for (const e of doc.edges) ids.add(e.id);
  return ids;
};

/** The ids of a device's ports on a board, to make the id of a new port from (see freshId). */
export function portIds(doc: Doc, device: DeviceNode): Set<string> {
  const ids = idsFor(doc);
  for (const p of device.ports) ids.add(p.id);
  return ids;
}

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

/** The prefix `id` was made with (see freshId), to make the id of a copy of what holds it; 'n' for none. */
export const prefixOf = (id: string): string => id.replace(/-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '').replace(/\d+$/, '') || 'n';

export const randomId = (): string => Math.random().toString(36).slice(2, 10);
