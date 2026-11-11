import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../src/model/types';
import type { BoardInfo } from '../src/platform/storage';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

let page: ReturnType<typeof stubPage>;
beforeAll(() => void (page = stubPage()));
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('going to another tab and back', () => {
  it('keeps the board’s undo steps and where it was looked at', async () => {
    const { boot, useStore } = await import('../src/model/store');
    const { backend, box } = versionedDisk([{ ...blank('aaa'), meta: { title: 'A', project: 'P' } }, { ...blank('bbb'), meta: { title: 'B', project: 'P' } }]);
    page.storage.set('keito:current', 'aaa');
    await boot(backend);
    const s = () => useStore.getState();
    s().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'A2' } }));
    s().setView({ x: 12, y: 34, k: 2 });
    s().openBoard('bbb');
    await vi.advanceTimersByTimeAsync(10);
    expect(s().doc.id).toBe('bbb');
    expect(s().past).toHaveLength(0);
    s().openBoard('aaa');
    await vi.advanceTimersByTimeAsync(10);
    expect(s().doc.meta.title).toBe('A2');
    expect(s().view).toEqual({ x: 12, y: 34, k: 2 });
    s().undo();
    expect(s().doc.meta.title).toBe('A');

    // Changed elsewhere meanwhile: the old steps no longer apply, and start afresh.
    s().openBoard('bbb');
    await vi.advanceTimersByTimeAsync(10);
    const a = box.kept.get('aaa')!;
    box.kept.set('aaa', { ...a, doc: { ...a.doc, meta: { ...a.doc.meta, title: 'A from the command line' } }, serial: a.serial + 1 });
    s().openBoard('aaa');
    await vi.advanceTimersByTimeAsync(10);
    expect(s().doc.meta.title).toBe('A from the command line');
    expect(s().past).toHaveLength(0);
  });

  it('keeps the board’s undo steps when it was left for a part of another board (the shared panel)', async () => {
    const { boot, useStore } = await import('../src/model/store');
    const part = { id: 'n1', type: 'text' as const, x: 0, y: 0, w: 10, h: 10, text: 'shared' };
    const { backend } = versionedDisk([{ ...blank('aaa'), meta: { title: 'A', project: 'P' } }, { ...blank('bbb'), meta: { title: 'B', project: 'P' }, nodes: [part] }]);
    page.storage.set('keito:current', 'aaa');
    await boot(backend);
    const s = () => useStore.getState();
    s().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'A2' } }));
    s().openAt('bbb', 'n1');
    await vi.advanceTimersByTimeAsync(10);
    expect(s().doc.id).toBe('bbb');
    s().openBoard('aaa');
    await vi.advanceTimersByTimeAsync(10);
    s().undo();
    expect(s().doc.meta.title).toBe('A');
  });
});

describe('opening a board deleted elsewhere', () => {
  it('stays on the board on screen, brings the list up to date and says so', async () => {
    const { boot, useStore } = await import('../src/model/store');
    const { backend, box } = versionedDisk([{ ...blank('aaa'), meta: { title: 'A', project: 'P' } }, { ...blank('bbb'), meta: { title: 'B', project: 'P' } }]);
    page.storage.set('keito:current', 'aaa');
    await boot(backend);
    const told = vi.spyOn(window, 'alert');
    box.kept.delete('bbb');
    useStore.getState().openBoard('bbb');
    await vi.advanceTimersByTimeAsync(10);
    expect(useStore.getState().doc.id).toBe('aaa');
    expect(useStore.getState().boards.map((b) => b.id)).toEqual(['aaa']);
    expect(told).toHaveBeenCalledOnce();
  });
});

/** Project P's tabs, in the order shown: B, C (system), A (sequence), Z (free); O alone in project Q. */
const boards: BoardInfo[] = [
  { id: 'seq', title: 'A', updated: 0, project: 'P', kind: 'sequence' },
  { id: 'c', title: 'C', updated: 0, project: 'P' },
  { id: 'b', title: 'B', updated: 0, project: 'P', kind: 'system' },
  { id: 'free', title: 'Z', updated: 0, project: 'P', kind: 'free' },
  { id: 'other', title: 'O', updated: 0, project: 'Q' },
];
const open = (id: string): Doc => {
  const b = boards.find((x) => x.id === id)!;
  return { ...blank(id), kind: b.kind, meta: { title: b.title, project: b.project ?? '' } };
};
const unfiled: Doc = { ...blank('x'), meta: { title: 'X', project: '' } };

describe('the next and the previous tab (⌘⇧] / ⌘⇧[)', () => {
  it('goes along the tabs as they are shown, and round from either end', async () => {
    const { boardBeside } = await import('../src/ui/BoardTabs');
    expect(boardBeside(open('b'), boards, 1)).toBe('c');
    expect(boardBeside(open('c'), boards, 1)).toBe('seq');
    expect(boardBeside(open('free'), boards, 1)).toBe('b');
    expect(boardBeside(open('b'), boards, -1)).toBe('free');
  });

  it('goes along the boards of a shared project, and none of this machine of the same project name', async () => {
    const { boardBeside } = await import('../src/ui/BoardTabs');
    const shared = [{ id: 's1', title: '配置' }, { id: 's2', title: '配線' }];
    const here: Doc = { ...blank('s1'), meta: { title: '配置', project: 'P' } };
    expect(boardBeside(here, boards, 1, undefined, shared)).toBe('s2');
    expect(boardBeside(here, boards, -1, undefined, shared)).toBe('s2');
    expect(boardBeside(here, boards, 1, undefined, [shared[0]])).toBeUndefined();
  });

  it('goes nowhere from a board alone in its project, or in none', async () => {
    const { boardBeside } = await import('../src/ui/BoardTabs');
    expect(boardBeside(open('other'), boards, 1)).toBeUndefined();
    expect(boardBeside(unfiled, boards, -1)).toBeUndefined();
  });
});

describe('a tab by its place (⌘1–⌘8, and ⌘9 for the last)', () => {
  it('counts the tabs as they are shown, the last from the end, and finds none past them', async () => {
    const { boardAt } = await import('../src/ui/BoardTabs');
    expect(boardAt(open('c'), boards, 0)).toBe('b');
    expect(boardAt(open('c'), boards, 2)).toBe('seq');
    expect(boardAt(open('c'), boards, -1)).toBe('free');
    expect(boardAt(open('c'), boards, 4)).toBeUndefined();
  });

  it('finds none past the board itself when it is alone in its project, or in none', async () => {
    const { boardAt } = await import('../src/ui/BoardTabs');
    expect(boardAt(open('other'), boards, 1)).toBeUndefined();
    expect(boardAt(unfiled, boards, 1)).toBeUndefined();
  });
});

/** A key press: the character, the modifiers held, and the key itself (e.code) where it matters. */
const press = (key: string, held: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}, code = '') =>
  ({ key, code, ctrlKey: !!held.ctrl, metaKey: !!held.meta, shiftKey: !!held.shift, altKey: !!held.alt }) as KeyboardEvent;

describe('the keys for a tab by its place', () => {
  it.each([
    ['⌘1', 0, press('1', { meta: true }, 'Digit1')],
    ['Ctrl+8', 7, press('8', { ctrl: true }, 'Digit8')],
    ['⌘9', -1, press('9', { meta: true }, 'Digit9')],
    // A digit typed alone, ⌘0 (zoom in other apps), and the digits with Shift or ⌥ go elsewhere.
    ['1', undefined, press('1', {}, 'Digit1')],
    ['⌘0', undefined, press('0', { meta: true }, 'Digit0')],
    ['⌘⇧1', undefined, press('!', { meta: true, shift: true }, 'Digit1')],
    ['⌘⌥1', undefined, press('¡', { meta: true, alt: true }, 'Digit1')],
  ] as const)('%s goes to place %s', async (_, at, e) => {
    const { tabPlace } = await import('../src/ui/tabKeys');
    expect(tabPlace(e)).toBe(at);
  });
});

describe('the keys for the next and the previous tab', () => {
  it.each([
    ['⌃Tab', 1, press('Tab', { ctrl: true })],
    ['Ctrl+PageDown', 1, press('PageDown', { ctrl: true })],
    ['⌃⇧Tab', -1, press('Tab', { ctrl: true, shift: true })],
    ['Ctrl+PageUp', -1, press('PageUp', { ctrl: true })],
    // Tab alone goes on to the next field, or to the next cell of a list.
    ['Tab', 0, press('Tab')],
    ['⌃⌥Tab', 0, press('Tab', { ctrl: true, alt: true })],
    ['Ctrl+Shift+PageDown', 0, press('PageDown', { ctrl: true, shift: true })],
  ] as const)('%s steps %i', async (_, step, e) => {
    const { tabStep } = await import('../src/ui/tabKeys');
    expect(tabStep(e)).toBe(step);
  });
});
