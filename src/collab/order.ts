/**
 * Orders everyone in a shared project sees alike: the nodes of a board as drawn, a device's ports,
 * the rows of a list put in order by hand. Each thing holds a place of its own, a number; things
 * stand by place, then by id, so that two put at one place at once (by two people) stand alike on
 * every screen. A move gives the things moved new places between those of the things they now
 * stand between, and changes nothing else: nothing is made anew, so what refers to a thing still
 * does, and a move by one person and an add or a move of other things by another, made at once,
 * are both kept.
 *
 * Kept apart from Yjs so that the app's first load does not carry it.
 */

/**
 * Things put elsewhere in an order, together and in this order: after `after` and before `before`,
 * the things around them that stay where they are (null: none, the run going first or last).
 */
export interface Run {
  ids: string[];
  after: string | null;
  before: string | null;
}

/** The ids of an order whose things stand at `places`, in it: by place, then by id. */
export function inOrder(places: ReadonlyMap<string, number>): string[] {
  return [...places].sort(([a, pa], [b, pb]) => pa - pb || (a < b ? -1 : a > b ? 1 : 0)).map(([id]) => id);
}

/**
 * Which things of `to` keep their places from `from`: the most of them that stand in the same order
 * in both. Of as many, those nearer the middle of `to`: [A, B, C] → [A, C, B] is B brought to the
 * front as much as C put behind it, and the thing at an end is the one moved to it (restack moves
 * the nodes picked to an end). Then those later in `to`, so that a thing moved goes before the
 * others, away from where things are added.
 */
function staying(from: readonly string[], to: readonly string[]): Set<string> {
  const at = new Map(from.map((id, i) => [id, i]));
  const both = to.flatMap((id, i) => (at.has(id) ? [{ id, from: at.get(id)!, weight: Math.min(i, to.length - 1 - i) }] : []));
  if (both.every((x, i) => i === 0 || both[i - 1].from < x.from)) return new Set(both.map((x) => x.id));
  const best = both.map((x) => ({ count: 1, weight: x.weight, prev: -1 }));
  const better = (a: { count: number; weight: number }, b: { count: number; weight: number }): boolean => a.count > b.count || (a.count === b.count && a.weight >= b.weight);
  let end = 0;
  for (let i = 0; i < both.length; i++) {
    for (let j = 0; j < i; j++) {
      if (both[j].from > both[i].from) continue;
      const run = { count: best[j].count + 1, weight: best[j].weight + both[i].weight, prev: j };
      if (better(run, best[i])) best[i] = run;
    }
    if (better(best[i], best[end])) end = i;
  }
  const out = new Set<string>();
  for (let i = end; i >= 0; i = best[i].prev) out.add(both[i].id);
  return out;
}

/**
 * The runs that turn the order `from` into `to`: what `to` holds but the things that keep their
 * places (see staying), the things `from` does not hold among them. None when `to` keeps `from`'s
 * order.
 */
export function runsBetween(from: readonly string[], to: readonly string[]): Run[] {
  const stay = staying(from, to);
  const runs: Run[] = [];
  let ids: string[] = [];
  let after: string | null = null;
  for (const id of to) {
    if (!stay.has(id)) {
      ids.push(id);
      continue;
    }
    if (ids.length) runs.push({ ids, after, before: id });
    ids = [];
    after = id;
  }
  if (ids.length) runs.push({ ids, after, before: null });
  return runs;
}

/**
 * Where in `order` the things `ids` of a run go: `rest`, the order without them, and `at`, where in
 * it. Last when the run went last, first when it went first, else right after `after`, or before
 * `before` once `after` is gone. `at` is -1 when both are gone, or `ids` is empty: nothing moves.
 */
function slotOf(order: readonly string[], run: Run, ids: readonly string[]): { rest: string[]; at: number } {
  const moving = new Set(ids);
  const rest = order.filter((id) => !moving.has(id));
  if (!ids.length) return { rest, at: -1 };
  if (run.before === null) return { rest, at: rest.length };
  if (run.after === null) return { rest, at: 0 };
  const after = rest.indexOf(run.after);
  return { rest, at: after >= 0 ? after + 1 : rest.indexOf(run.before) };
}

/** `order` with the runs moved where they go (see slotOf); a thing it does not hold is put there only when `adding`. */
export function withRuns(order: readonly string[], runs: readonly Run[], adding = false): string[] {
  let out = [...order];
  for (const run of runs) {
    const ids = adding ? run.ids : run.ids.filter((id) => out.includes(id));
    const { rest, at } = slotOf(out, run, ids);
    if (at >= 0) out = [...rest.slice(0, at), ...ids, ...rest.slice(at)];
  }
  return out;
}

/** `n` places in order between `lo` and `hi` (undefined: no end there); null when the numbers leave no room. */
function spaced(lo: number | undefined, hi: number | undefined, n: number): number[] | null {
  const start = lo ?? (hi === undefined ? -1 : hi - n - 1);
  const step = lo === undefined || hi === undefined ? 1 : (hi - lo) / (n + 1);
  const out = Array.from({ length: n }, (_, i) => start + step * (i + 1));
  return [start, ...out, hi ?? Infinity].every((p, i, all) => i === 0 || all[i - 1] < p) ? out : null;
}

/**
 * Give the things of each run places in an order whose things stand at `places`, where withRuns
 * would put them in it, between the places of the things around them as they are now: by `set`,
 * and only things `there` (one taken off meanwhile is passed over). Where two of those stand at one
 * place, or their numbers are too close to part, there is no room: the things next to them are
 * given new places too, as few as leave room, so that a move of things elsewhere made at once by
 * another person is kept.
 */
export function placeRuns(places: ReadonlyMap<string, number>, runs: readonly Run[], there: (id: string) => boolean, set: (id: string, place: number) => void): void {
  const now = new Map(places);
  for (const run of runs) {
    const ids = run.ids.filter(there);
    const { rest, at } = slotOf(inOrder(now), run, ids);
    if (at < 0) continue;
    // With no thing around (lo 0, hi rest.length) there is always room: the loop ends.
    for (let lo = at, hi = at; ; lo = Math.max(0, lo - 1), hi = Math.min(rest.length, hi + 1)) {
      const moved = [...rest.slice(lo, at), ...ids, ...rest.slice(at, hi)];
      const room = spaced(now.get(rest[lo - 1]), now.get(rest[hi]), moved.length);
      if (!room) continue;
      moved.forEach((id, i) => {
        now.set(id, room[i]);
        set(id, room[i]);
      });
      break;
    }
  }
}
