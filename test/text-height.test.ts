import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { textHeightFor } from '../src/canvas/render';
import { openText } from '../src/collab/typing';
import { makeNode } from '../src/model/presets';
import { type TextRange, bindField } from '../src/ui/typing';

it('reports a peer’s lines to the editor so it can grow for the merged text', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const initial = 'A1\nA2\n図形';
  const text = a.getText('label');
  text.insert(0, initial);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

  const copy = b.getText('label');
  const origin = Symbol('typing');
  const history = new Y.UndoManager(copy, { trackedOrigins: new Set([origin]) });
  const transact = (write: () => void) => b.transact(write, origin);
  const session = openText(copy, { origin, history, transact, outsideHistory: transact, joins: false, alive: () => true });
  const node = { ...makeNode('rect', 0, 0, new Set()), h: 90 };
  let shown = initial;
  let range: TextRange = [0, 0];
  const heard = vi.fn(() => textHeightFor(node, session.value()));
  const typing = bindField({ read: () => ({ text: shown, range }), write: (s, r) => { shown = s; range = r; } }, session, { heard });
  try {
    text.insert(initial.length, '\nB1\nB2');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));

    expect(shown).toBe('A1\nA2\n図形\nB1\nB2');
    expect(heard, 'the height for the text the editor heard').toHaveReturnedWith(120);

    typing.insert('Local');
    typing.undo();
    expect(shown).toBe('A1\nA2\n図形\nB1\nB2');
    expect(heard).toHaveBeenCalledTimes(1);
  } finally {
    typing.close();
    session.end(true);
    a.destroy();
    b.destroy();
  }
});
