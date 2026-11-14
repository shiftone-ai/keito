/**
 * Changes to a plain text as deltas, the form Yjs (and Quill) gives them: ops run over the text from
 * its start, each keeping (`retain`), putting in (`insert`) or taking out (`delete`) characters, and
 * what follows the last op is kept. Without Yjs, so that a field typed into can use them on the
 * app's first load.
 */
export type TextOp = { insert: string } | { delete: number } | { retain: number };
export type TextDelta = readonly TextOp[];

const lengthOf = (op: TextOp): number => ('insert' in op ? op.insert.length : 'delete' in op ? op.delete : op.retain);

/** Add an op, joined to the last when it is of the same kind; empty ones are left out. */
function push(out: TextOp[], op: TextOp): void {
  if (!lengthOf(op)) return;
  const last = out.at(-1);
  if (last && 'insert' in last && 'insert' in op) out[out.length - 1] = { insert: last.insert + op.insert };
  else if (last && 'delete' in last && 'delete' in op) out[out.length - 1] = { delete: last.delete + op.delete };
  else if (last && 'retain' in last && 'retain' in op) out[out.length - 1] = { retain: last.retain + op.retain };
  else out.push(op);
}

/** The ops of a delta, taken a part at a time; past the last, the rest of the text is kept. */
function reader(delta: TextDelta) {
  let i = 0;
  let used = 0;
  const op = (): TextOp | undefined => delta[i];
  return {
    more: (): boolean => i < delta.length,
    kind: (): 'insert' | 'delete' | 'retain' => {
      const o = op();
      return !o ? 'retain' : 'insert' in o ? 'insert' : 'delete' in o ? 'delete' : 'retain';
    },
    left: (): number => {
      const o = op();
      return o ? lengthOf(o) - used : Infinity;
    },
    /** Up to `n` characters of the op at hand (all that is left of it by default). */
    take(n = Infinity): TextOp {
      const o = op();
      if (!o) return { retain: n };
      const k = Math.min(n, lengthOf(o) - used);
      const part: TextOp = 'insert' in o ? { insert: o.insert.slice(used, used + k) } : 'delete' in o ? { delete: k } : { retain: k };
      used += k;
      if (used === lengthOf(o)) {
        i++;
        used = 0;
      }
      return part;
    },
  };
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * The change that turns `before` into `after`, one stretch replaced. `caret`: where the caret is in
 * `after`, which the characters put in end at: it tells where a character typed among others the
 * same went ("aa" to "aaa"). A character made of two halves (an emoji) is never cut in two.
 */
export function deltaBetween(before: string, after: string, caret: number): TextDelta {
  const most = Math.min(before.length, after.length);
  let end = 0;
  const endMost = Math.min(most, Math.max(0, after.length - caret));
  while (end < endMost && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  let start = 0;
  while (start < most - end && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
  if (end > 0 && isLow(before.charCodeAt(before.length - end))) end--;
  const out: TextOp[] = [];
  push(out, { retain: start });
  push(out, { delete: before.length - end - start });
  push(out, { insert: after.slice(start, after.length - end) });
  return out;
}

/**
 * `delta` made to follow `first`, both made to the same text: the same change, made to the text
 * `first` turned it into. Where both put characters at one place, those of `first` stay before
 * when `firstBefore`. What `first` took out is not taken out again, and what it put in inside a
 * stretch `delta` takes out is kept: nobody's typing is lost to another's.
 */
export function rebase(first: TextDelta, delta: TextDelta, firstBefore: boolean): TextDelta {
  const a = reader(first);
  const b = reader(delta);
  const out: TextOp[] = [];
  while (a.more() || b.more()) {
    if (a.kind() === 'insert' && (firstBefore || b.kind() !== 'insert')) push(out, { retain: lengthOf(a.take()) });
    else if (b.kind() === 'insert') push(out, b.take());
    else {
      const n = Math.min(a.left(), b.left());
      const x = a.take(n);
      const y = b.take(n);
      if (!('delete' in x)) push(out, 'delete' in y ? y : { retain: n });
    }
  }
  if (out.length && 'retain' in out[out.length - 1]) out.pop();
  return out;
}

/**
 * Where a place in a text is once `delta` is made to it. `stays`: a place where `delta` puts
 * characters stays before them (a caret another's typing goes in front of); else it goes after.
 */
export function mapIndex(index: number, delta: TextDelta, stays: boolean): number {
  let at = index;
  let offset = 0;
  for (const op of delta) {
    if (offset > at) break;
    if ('delete' in op) {
      at -= Math.min(op.delete, at - offset);
      continue;
    }
    if ('insert' in op && (offset < at || !stays)) at += op.insert.length;
    offset += lengthOf(op);
  }
  return at;
}
