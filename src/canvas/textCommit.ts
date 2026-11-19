import type { Peer } from '../collab/presence';
import type { Node } from '../model/types';

/** Whether an empty text box or a box just dropped with a double-click goes when editing ends. */
export function emptyTextGoes(
  node: Node | undefined,
  text: string,
  dropped: boolean,
  shared?: { board: string; peers: readonly Pick<Peer, 'board' | 'editing'>[] },
): boolean {
  if (!node || text || (node.type !== 'text' && !dropped)) return false;
  return !shared?.peers.some((peer) => peer.board === shared.board && peer.editing.includes(node.id));
}
