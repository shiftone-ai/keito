import { nodeRect } from '../model/geometry';
import type { State } from '../model/store';
import type { Doc, Pt } from '../model/types';
import type { BoardEdit } from './edits';
import { type Me, keepMe, myself } from './me';
import type { Presence, SharedPresence } from './presence';
import type { Host } from './target';

type Operation = Pick<Presence, 'editing' | 'moving'>;
const NO_OPERATION: Operation = { editing: [], moving: [] };

/**
 * What an operation under way changes of the board as it shows it: the nodes and lines it changes or
 * puts there, and where the nodes it moves, resizes or puts there are.
 */
function operationOf(doc: Doc, draft: BoardEdit): Operation {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const lines = new Set(doc.edges.map((e) => e.id));
  const placed = draft.add.map((p) => p.node.id);
  const changedNodes = [...draft.set.keys(), ...placed, ...draft.ports.keys()].filter((id) => nodes.has(id));
  const changedLines = [...draft.lines.set.keys(), ...draft.lines.add.map((l) => l.id)].filter((id) => lines.has(id));
  const moved = [...draft.set].filter(([, change]) => 'x' in change || 'w' in change).map(([id]) => id);
  return {
    editing: [...new Set([...changedNodes, ...changedLines])],
    moving: [...new Set([...placed, ...moved])].flatMap((id) => {
      const n = nodes.get(id);
      return n ? [{ id, ...nodeRect(n) }] : [];
    }),
  };
}

/**
 * The others in a shared project, shown as they come and go (State.peers, cleared on `close`), and
 * what the page tells them of itself while it shows the project: who its user is (myself), the board
 * on screen, the pointer there, what is selected, and what an operation under way changes, the nodes
 * it moves where they are as it goes. Only what is written to the project, as the operation ends,
 * changes the board for the others. Nothing heard of them changes anything of this page's own.
 */
export function followPeers(presence: SharedPresence, host: Pick<Host, 'get' | 'set' | 'watch'>) {
  let operation = NO_OPERATION;
  const editing = (s: State): string[] => [...new Set([...(s.editing ? [s.editing] : []), ...operation.editing])];
  const tellOperation = (): void => presence.share({ editing: editing(host.get()), moving: operation.moving });
  const show = (): void => host.set({ peers: presence.peers() });

  presence.share({ ...myself(), selection: host.get().selection, editing: editing(host.get()) });
  show();
  const unlisten = presence.listen(show);
  const unwatch = host.watch((s, prev) => {
    if (s.selection !== prev.selection) presence.share({ selection: s.selection });
    if (s.editing !== prev.editing) presence.share({ editing: editing(s) });
  });

  return {
    /** The board now on screen ('' for none): nothing of the one before is told any longer. */
    board(board: string): void {
      operation = NO_OPERATION;
      presence.share({ board, pointer: null, selection: [], editing: [], moving: [] });
    },
    /** The pointer is at `at` on the board on screen; null: off it. */
    point(at: Pt | null): void {
      presence.share({ pointer: at && { x: Math.round(at.x), y: Math.round(at.y) } });
    },
    /** Show this device's user as `me` from now on, here and in every shared project opened on this device. */
    introduce(me: Me): Me {
      const now = keepMe(me);
      presence.share(now);
      return now;
    },
    /** The operation under way changes `draft` of the board, which shows it as `doc`. */
    during(doc: Doc, draft: BoardEdit): void {
      operation = operationOf(doc, draft);
      tellOperation();
    },
    /** The operation under way has ended, written to the project or called off. */
    settled(): void {
      if (operation === NO_OPERATION) return;
      operation = NO_OPERATION;
      tellOperation();
    },
    close(): void {
      unlisten();
      unwatch();
      host.set({ peers: [] });
    },
  };
}
