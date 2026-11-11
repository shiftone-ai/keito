import * as Y from 'yjs';
import type { Edge, EdgeEnd, Pt } from '../model/types';
import type { Change, Items } from './edits';
import { type Check, type YMap, inOrder, isBoolean, isNumber, isString, oneOf, orderRange, textOf } from './nodes';
import { LINE_ATTRIBUTES, type LineAttribute } from './scope';

/**
 * The lines of a shared board as the project holds them (see model.ts for the rest of the project):
 *
 * line: Y.Map { id, order, ends: { from, to }, label: Y.Text, note: Y.Text, …its attributes }
 *
 * The two ends are one value: two people pulling the ends of one line at once end with the ends one
 * of them gave it, never a line neither drew. Each attribute is a key of its own (see LINE_ATTRIBUTES
 * in scope.ts), so one person's rewiring and another's change to the cable are both kept. What the
 * drawing leaves out (a line whose node or port is gone) is valid.ts's.
 */

const isPoint: Check = (v) => !!v && typeof v === 'object' && isNumber((v as Pt).x) && isNumber((v as Pt).y);

/** What a value written under each attribute must be to be read back: anything else is left unread. */
const CHECKS = {
  signal: isString,
  length: (v) => v === null || isNumber(v),
  arrow: oneOf(['none', 'end', 'both']),
  dash: isBoolean,
  cableId: isString,
  showId: isBoolean,
  showLength: isBoolean,
  stacked: isBoolean,
  showProtocol: isBoolean,
  spec: isString,
  maker: isString,
  model: isString,
  url: isString,
  color: isString,
  fontSize: isNumber,
  labelAt: isNumber,
  route: (v) => Array.isArray(v) && v.every(isPoint),
  tidied: isBoolean,
  tag: isBoolean,
} satisfies Record<LineAttribute, Check>;

/** What every line holds (see makeEdge): one without them is not whole. */
const REQUIRED: readonly LineAttribute[] = ['signal', 'length', 'arrow'];

const SIDES = oneOf(['left', 'right', 'top', 'bottom']);

/** An end of a line holding only what an end holds; null for what is not one. */
function endOf(v: unknown): EdgeEnd | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isString(o.node)) return null;
  const end: EdgeEnd = { node: o.node as string };
  if (isString(o.port)) end.port = o.port as string;
  if (SIDES(o.side)) end.side = o.side as EdgeEnd['side'];
  if (isNumber(o.at)) end.at = o.at as number;
  return end;
}

const endsOf = (from: unknown, to: unknown) => ({ from: endOf(from), to: endOf(to) });

/** A line as the drawing reads it; null for one not whole. */
function lineOf(id: string, line: YMap): Edge | null {
  const ends = line.get('ends') as Record<string, unknown> | undefined;
  const { from, to } = endsOf(ends?.from, ends?.to);
  if (!from || !to) return null;
  const out: Record<string, unknown> = { id, from, to, label: textOf(line.get('label')), note: textOf(line.get('note')) };
  for (const key of LINE_ATTRIBUTES) {
    const v = line.get(key);
    if (CHECKS[key](v)) out[key] = v;
  }
  return REQUIRED.every((key) => key in out) ? (out as unknown as Edge) : null;
}

/** A board's lines as the project holds them (those not whole left out), in the order they were put there. */
export const readLines = (lines: YMap): Edge[] => inOrder(lines, lineOf);

function putLine(lines: YMap, e: Edge, order: number): void {
  const line = new Y.Map<unknown>();
  lines.set(e.id, line);
  line.set('id', e.id);
  line.set('order', order);
  line.set('ends', endsOf(e.from, e.to));
  line.set('label', new Y.Text(e.label));
  line.set('note', new Y.Text(e.note));
  for (const key of LINE_ATTRIBUTES) if (e[key] !== undefined) line.set(key, e[key]);
}

/** Change attributes of a line in place, each on its own; its ends, both at once. */
function changeLine(line: YMap, change: Change): void {
  if ('from' in change) line.set('ends', endsOf(change.from, change.to));
  for (const [key, v] of Object.entries(change)) {
    if (key === 'from' || key === 'to') continue;
    if (v === undefined) line.delete(key);
    else line.set(key, v);
  }
}

/**
 * Write an edit of a board's lines (within the caller's transaction). A change to a line no longer
 * there is dropped, never bringing the line back; a line put there under an id already taken is not
 * written over what holds it. New lines go after the rest.
 */
export function writeLines(lines: YMap, edit: Items<Edge>): void {
  for (const id of edit.remove) lines.delete(id);
  for (const [id, change] of edit.set) {
    const line = lines.get(id);
    if (line instanceof Y.Map) changeLine(line, change);
  }
  let { front } = orderRange(lines);
  for (const e of edit.add) if (!lines.has(e.id)) putLine(lines, e, ++front);
}
