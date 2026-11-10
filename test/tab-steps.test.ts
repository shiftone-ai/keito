import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

let page: ReturnType<typeof stubPage>;
beforeAll(() => void (page = stubPage()));
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('⌘⇧] pressed again while the next board is opening', () => {
  it('goes on from the board still opening', async () => {
    const { boot, useStore } = await import('../src/model/store');
    const { nextTab, openTab } = await import('../src/ui/BoardTabs');
    const board = (id: string, title: string) => ({ ...blank(id), meta: { title, project: 'P' } });
    const { backend, box } = versionedDisk([board('a', 'A'), board('b', 'B'), board('c', 'C')]);
    page.storage.set('keito:current', 'a');
    await boot(backend);
    box.delay = 100;
    openTab(nextTab(1)!);
    openTab(nextTab(1)!);
    await vi.advanceTimersByTimeAsync(500);
    expect(useStore.getState().doc.id).toBe('c');
  });

  it('stays on the board on screen when pressed back to it before the next one opens', async () => {
    const { useStore } = await import('../src/model/store');
    const { nextTab, openTab } = await import('../src/ui/BoardTabs');
    const here = useStore.getState().doc.id;
    openTab(nextTab(1)!);
    openTab(nextTab(-1)!);
    await vi.advanceTimersByTimeAsync(500);
    expect(useStore.getState().doc.id).toBe(here);
  });
});
