import * as Y from 'yjs';
import type { Doc } from '../model/types';
import type { ListEdit } from './edits';
import { type YMap, isNumber } from './entries';
import { inOrder, placeRuns } from './order';

/**
 * The lists of a board put in order by hand (Doc.listOrder, see model/lists.ts) as the project holds
 * them: each thing a list names (a device, a line) holds its place in that list under
 * `order:<list>`, a key of its own (see order.ts), so that rows two people drag at once are both
 * kept. A thing without one stands after the others, in the list's own order. Held on the things
 * themselves: a thing taken off takes its places with it, and brings them back when put back.
 */

const PREFIX = 'order:';
const key = (list: string): string => PREFIX + list;

/** The places in each list of the things in `maps` (a board's nodes and lines), by id. */
function placesOf(maps: readonly YMap[]): Map<string, Map<string, number>> {
  const lists = new Map<string, Map<string, number>>();
  for (const map of maps)
    map.forEach((entry, id) => {
      if (!(entry instanceof Y.Map)) return;
      (entry as YMap).forEach((place, k) => {
        if (!k.startsWith(PREFIX) || !isNumber(place)) return;
        const list = k.slice(PREFIX.length);
        if (!lists.has(list)) lists.set(list, new Map());
        lists.get(list)!.set(id, place as number);
      });
    });
  return lists;
}

/** The lists' orders of the things in `maps` (a board's nodes and lines) that are `drawn`, each list by name; undefined for none. */
export function readListOrder(maps: readonly YMap[], drawn: ReadonlySet<string>): Doc['listOrder'] {
  const lists = [...placesOf(maps)]
    .map(([list, places]): [string, string[]] => [list, inOrder(places).filter((id) => drawn.has(id))])
    .filter(([, ids]) => ids.length);
  // By name, not as the maps happen to hold them: every client reads the same board.
  return lists.length ? Object.fromEntries(lists.sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
}

/** Write an edit of the lists' orders on the things in `maps` (within the caller's transaction): a thing no longer there is passed over. */
export function writeListOrder(maps: readonly YMap[], lists: ReadonlyMap<string, ListEdit>): void {
  if (!lists.size) return;
  const entry = (id: string): YMap | undefined => maps.map((map) => map.get(id)).find((e): e is YMap => e instanceof Y.Map);
  const held = placesOf(maps);
  for (const [list, { reset, moves }] of lists) {
    const places = held.get(list) ?? new Map<string, number>();
    if (reset) {
      for (const id of places.keys()) entry(id)?.delete(key(list));
      places.clear();
    }
    placeRuns(places, moves, (id) => !!entry(id), (id, place) => entry(id)!.set(key(list), place));
  }
}
