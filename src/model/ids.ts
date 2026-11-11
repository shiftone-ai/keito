import type { Doc } from './types';

export const allIds = (doc: Doc): Set<string> => {
  const ids = new Set<string>();
  for (const n of doc.nodes) {
    ids.add(n.id);
    if (n.type === 'device') for (const p of n.ports) ids.add(`${n.id}/${p.id}`);
  }
  for (const e of doc.edges) ids.add(e.id);
  return ids;
};

/** Short human-readable id (also used as the handle in the YAML text form). */
export function freshId(taken: Set<string>, prefix: string): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

export const randomId = (): string => Math.random().toString(36).slice(2, 10);
