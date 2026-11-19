import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

let page: ReturnType<typeof stubPage>;
beforeAll(() => void (page = stubPage()));
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Boards of one project, opened on the first; from then on, each takes 100 ms to load. */
async function start(...ids: string[]) {
  const { boot, useStore } = await import('../src/model/store');
  const { nextTab } = await import('../src/ui/tabKeys');
  const { backend, box } = versionedDisk(ids.map((id) => ({ ...blank(id), meta: { title: id, project: 'P' } })));
  page.storage.set('keito:current', ids[0]);
  await boot(backend);
  box.delay = 100;
  return {
    backend,
    box,
    state: useStore.getState,
    press: (step: 1 | -1) => useStore.getState().openBoard(nextTab(step)!),
    click: (id: string) => useStore.getState().openBoard(id),
    wait: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    /** The board on screen now, loads still under way left as they are. */
    now: () => useStore.getState().doc.id,
    shown: async () => {
      await vi.advanceTimersByTimeAsync(1000);
      return useStore.getState().doc.id;
    },
  };
}

describe('⌘⇧] / ⌘⇧[ pressed again before the board opens', () => {
  it('goes one tab further on each press', async () => {
    const { press, shown } = await start('a', 'b', 'c');
    press(1);
    press(1);
    expect(await shown()).toBe('c');
  });

  it('cancels the load when pressed back to the board on screen, and counts from that board', async () => {
    const { press, shown } = await start('a', 'b', 'c');
    press(1); // b
    press(-1); // a, the board on screen: the load of b is cancelled
    press(-1); // c
    expect(await shown()).toBe('c');
  });

  it('counts from the board still loading after an earlier, cancelled load of the same board ends', async () => {
    const { press, wait, shown } = await start('a', 'b');
    press(1); // b
    press(1); // a, the board on screen: the load of b is cancelled
    await wait(10);
    press(1); // b again
    await wait(95); // the cancelled load of b ends
    press(1); // a
    expect(await shown()).toBe('a');
  });

  it('counts from a tab clicked while a board is loading', async () => {
    const { press, click, shown } = await start('a', 'b', 'c', 'd');
    press(1); // b
    click('d');
    press(1); // a, the tab after d
    expect(await shown()).toBe('a');
  });
});

describe('the board still loading, asked for again (⌘N held down, or its tab clicked twice)', () => {
  it('lets its load go on, rather than start it over', async () => {
    const { click, wait, now } = await start('a', 'b');
    click('b');
    await wait(50);
    click('b');
    await wait(60);
    expect(now()).toBe('b');
  });
});

describe('edits made while another board is loading', () => {
  it.each([
    ['when its tab is clicked again', true],
    ['without clicking its tab again', false],
  ])('writes the edit before showing the loaded board %s', async (_, clickAgain) => {
    const { box, state, click, wait, now } = await start('a', 'b');
    click('b');
    await wait(50);
    expect(now()).toBe('a');
    state().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'a edited' } }));
    if (clickAgain) click('b');
    await wait(60);
    expect(now()).toBe('b');
    expect(box.kept.get('a')?.doc.meta.title).toBe('a edited');
  });

  it('keeps editing while the write is under way, and can undo the last edit on return', async () => {
    const { backend, box, state, click, wait, now } = await start('a', 'b');
    click('b');
    await wait(50);
    const save = backend.save;
    vi.spyOn(backend, 'save').mockImplementationOnce(async (doc) => {
      await new Promise((done) => setTimeout(done, 50));
      await save(doc);
    });
    state().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'first edit' } }));
    await wait(60);
    expect(now()).toBe('a');
    state().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'second edit' } }));
    const view = { x: 12, y: 34, k: 2 };
    state().setView(view);
    await wait(50);
    expect(now()).toBe('b');
    expect(box.kept.get('a')?.doc.meta.title).toBe('second edit');
    click('a');
    await wait(110);
    expect(now()).toBe('a');
    expect(state().view).toEqual(view);
    state().undo();
    expect(state().doc.meta.title).toBe('first edit');
  });

  it('stays on the board if its edit conflicts with a write elsewhere', async () => {
    const { box, state, click, wait, now } = await start('a', 'b');
    click('b');
    await wait(50);
    state().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'a edited' } }));
    const a = box.kept.get('a')!;
    box.kept.set('a', { doc: { ...a.doc, meta: { ...a.doc.meta, title: 'a changed elsewhere' } }, serial: a.serial + 1 });
    await wait(60);
    expect(now()).toBe('a');
    expect(state().saving).toBe('conflict');
    expect(box.kept.get('a')?.doc.meta.title).toBe('a changed elsewhere');
  });

  it('stays on the board if its edit could not be written and the user keeps it', async () => {
    const { backend, state, click, wait, now } = await start('a', 'b');
    click('b');
    await wait(50);
    vi.spyOn(backend, 'save').mockRejectedValueOnce(new Error('store unavailable'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    try {
      state().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'a edited' } }));
      await wait(60);
      expect(now()).toBe('a');
      expect(state().saving).toBe('error');
      expect(state().doc.meta.title).toBe('a edited');
      expect(confirm).toHaveBeenCalledOnce();
    } finally {
      confirm.mockRestore();
    }
  });
});
