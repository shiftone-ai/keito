import { expect, it } from 'vitest';
import { emptyTextGoes } from '../src/canvas/textCommit';
import { makeNode } from '../src/model/presets';

it('keeps an empty text box while a peer is editing it on the same board', () => {
  const node = makeNode('text', 0, 0, new Set());
  const peer = { board: 'main', editing: [node.id] };

  expect(emptyTextGoes(node, '', false, { board: 'main', peers: [peer] }), 'the peer’s text box stays').toBe(false);
  expect(emptyTextGoes(node, '', false, { board: 'other', peers: [peer] })).toBe(true);
  expect(emptyTextGoes(node, '', false, { board: 'main', peers: [{ ...peer, editing: ['another'] }] })).toBe(true);
  expect(emptyTextGoes(node, '', false, { board: 'main', peers: [] })).toBe(true);
  expect(emptyTextGoes(node, '', false)).toBe(true);
});
