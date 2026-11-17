import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceTagRects, tagsStacked } from '../src/model/badges';
import { captionBox } from '../src/model/geometry';
import { makeDevice, makeEdge, presetOf } from '../src/model/presets';
import type { Doc, ImageNode, Node, Rect } from '../src/model/types';
import { blank } from './helpers';
import { stubPage } from './page';

beforeEach(() => void stubPage());
afterEach(() => vi.unstubAllGlobals());

describe('the name tag of a page on what it picked', () => {
  it('is over what is drawn above it, covering none of it: the address and the power load of a device, on one row or the address on a row of its own, and the caption on top of a picture, at any zoom', async () => {
    const { TAG_H, tagAt } = await import('../src/canvas/PeerMarks');
    const taken = new Set<string>();
    const pc = { ...makeDevice(presetOf('pc')!, 0, 0, taken), ip: '10.0.0.6', host: 'td-main' };
    const ups = { ...makeDevice(presetOf('ups')!, 400, 0, taken), ip: '192.168.100.200', host: 'ups-rack-main' };
    const picture: ImageNode = { id: 'picture', type: 'image', x: 800, y: 0, w: 200, h: 120, text: '', src: '', caption: '会場の図面', captionAt: 'top' };
    const doc: Doc = { ...blank('board'), nodes: [pc, ups, picture], edges: [makeEdge(taken, { node: ups.id }, { node: pc.id }, 'power')] };
    const drawnAbove = (n: Node): Rect[] => [...(n.type === 'device' ? deviceTagRects(doc, n) : []), ...[captionBox(n)].flatMap((caption) => caption ?? [])];
    expect([pc, ups].map((device) => [drawnAbove(device).length, tagsStacked(doc, device)])).toEqual([[1, false], [2, true]]);

    for (const k of [0.5, 1, 2])
      for (const node of [pc, ups, picture]) {
        const gap = Math.min(...drawnAbove(node).map((drawn) => drawn.y)) - (tagAt(doc, node, k).y + TAG_H / k);
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThan(TAG_H / k);
      }
  });
});
