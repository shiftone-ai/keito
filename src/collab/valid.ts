import type { Doc, EdgeEnd } from '../model/types';

/**
 * The board with only the lines it can draw: each end on a node of the board and, when the end names
 * a port, on that port of the device. A line whose node or port someone took off while another
 * connected it stays in the project, left out here: every screen, table and export reads the board
 * through this, so all leave out the same lines whatever order the edits came in, and none is mended
 * on one screen alone. Kept apart from Yjs so that the app's first load does not carry it.
 */
export function validDrawing(doc: Doc): Doc {
  const ports = new Map(doc.nodes.map((n) => [n.id, n.type === 'device' ? new Set(n.ports.map((p) => p.id)) : null]));
  const there = (end: EdgeEnd): boolean => ports.has(end.node) && (end.port === undefined || !!ports.get(end.node)?.has(end.port));
  const edges = doc.edges.filter((e) => there(e.from) && there(e.to));
  return edges.length === doc.edges.length ? doc : { ...doc, edges };
}
