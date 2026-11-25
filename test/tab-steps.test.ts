import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';
import type { DeviceNode } from '../src/model/types';

let page: ReturnType<typeof stubPage>;
beforeAll(() => void (page = stubPage()));
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Boards of one project, opened on the first; from then on, each takes 100 ms to load. */
async function start(...ids: string[]) {
  const { boot, useStore } = await import('../src/model/store');
  const { nextTab } = await import('../src/ui/tabKeys');
  const shape: DeviceNode = { id: 'n1', type: 'device', x: 0, y: 0, w: 160, h: 0, text: 'old', maker: '', model: '', category: '', note: '', ports: [], shared: 'pc', sharedAt: 1 };
  const { backend, box } = versionedDisk(ids.map((id) => ({ ...blank(id), meta: { title: id, project: 'P' }, nodes: [shape] })));
  page.storage.set('keito:current', ids[0]);
  // A board of the same id left on screen by an earlier test would make this one's opening look like an edit of it.
  useStore.setState({ ready: false, doc: blank('none') });
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
    keepState: async () => {
      box.delay = 0;
      useStore.getState().nameState('kept');
      await vi.advanceTimersByTimeAsync(1000);
      box.delay = 100;
      vi.spyOn(backend, 'loadRevision').mockResolvedValue({ ...blank(ids[0]), meta: { title: ids[0], project: 'P' } });
      return useStore.getState().doc.revisions!.at(-1)!.id;
    },
    justShown: async (id: string) => {
      for (let ms = 0; ms < 10_000 && useStore.getState().doc.id !== id; ms++) await vi.advanceTimersByTimeAsync(1);
      return useStore.getState().doc.id;
    },
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
    await wait(170);
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
    await wait(160);
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

describe('a state from the history opened while another board loads', () => {
  it.each([
    ['left open', false],
    ['closed again', true],
  ] as const)('keeps the undo steps of the board left, with the state %s', async (_how, closeAgain) => {
    const { state, click, wait, now, keepState } = await start('a', 'b');
    state().updateNode('n1', { x: 12 });
    const revision = await keepState();
    click('b');
    await wait(50);
    state().viewRevision(revision);
    await wait(10);
    expect(state().viewing).toBeTruthy();
    if (closeAgain) state().exitRevision();
    await wait(100);
    expect(now()).toBe('b');

    click('a');
    await wait(200);
    expect(now()).toBe('a');
    state().undo();
    expect(state().doc.nodes[0].x).toBe(0);
  });

  it('keeps the undo step of an edit made just before the state is opened', async () => {
    const { state, click, wait, now, keepState } = await start('a', 'b');
    const revision = await keepState();
    click('b');
    await wait(50);
    state().updateNode('n1', { x: 24 });
    state().viewRevision(revision);
    await wait(10);
    expect(state().viewing).toBeTruthy();
    await wait(200);
    expect(now()).toBe('b');

    click('a');
    await wait(200);
    expect(now()).toBe('a');
    expect(state().doc.nodes[0].x).toBe(24);
    state().undo();
    expect(state().doc.nodes[0].x).toBe(0);
  });
});

describe('a state from the history clicked again while a shared edit is being written', () => {
  it('says the board is saved once it is', async () => {
    const { backend, state, wait, keepState } = await start('a', 'b');
    await wait(200);
    const revision = await keepState();
    const save = backend.save;
    vi.spyOn(backend, 'save').mockImplementation(async (doc) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await save(doc);
    });
    state().updateNode('n1', { text: 'new' });
    state().viewRevision(revision);
    await wait(80);
    state().viewRevision(revision);
    await wait(1000);
    state().exitRevision();
    expect(state().saving).toBe('saved');
  });
});

describe('a board edited while a state from the history waits for a shared edit to be written', () => {
  it('saves the board, never the state opened over it', async () => {
    const { box, state, wait, keepState } = await start('a', 'b', 'c');
    await wait(200);
    const revision = await keepState();
    state().updateNode('n1', { text: 'new' });
    await wait(850);
    state().viewRevision(revision);
    await wait(50);
    state().updateNode('n1', { x: 9 });
    await wait(3000);
    expect(state().viewing).toBeTruthy();
    expect(box.kept.get('a')?.doc.nodes[0]).toMatchObject({ text: 'new', x: 9 });
  });
});

describe('a board edited while a state from the history loads', () => {
  it('never writes the state over the board', async () => {
    const { backend, box, state, wait, keepState } = await start('a', 'b');
    const revision = await keepState();
    vi.spyOn(backend, 'loadRevision').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ...blank('a'), meta: { title: 'a state', project: 'P' } };
    });
    state().viewRevision(revision);
    await wait(10);
    state().updateNode('n1', { x: 9 });
    await wait(2000);
    expect(state().viewing).toBeTruthy();
    expect(box.kept.get('a')?.doc.meta.title).toBe('a');
  });
});

describe('a shared device edited while another board loads', () => {
  it('keeps the edit on every board when the next one is edited as soon as it is shown', async () => {
    const { box, state, click, wait, justShown } = await start('a', 'b');
    click('b');
    await wait(50);
    state().updateNode('n1', { text: 'new' });
    expect(await justShown('b')).toBe('b');
    expect(state().doc.nodes[0]).toMatchObject({ text: 'new' });
    state().updateNode('n1', { ip: '10.0.0.2' });
    await wait(2000);
    for (const id of ['a', 'b']) expect(box.kept.get(id)?.doc.nodes[0]).toMatchObject({ text: 'new', ip: '10.0.0.2' });
  });

  it('shows the edit made while the one before it is being written to the other boards', async () => {
    const { state, click, wait, justShown } = await start('a', 'b');
    click('b');
    await wait(50);
    state().updateNode('n1', { text: 'ne' });
    await wait(100);
    state().updateNode('n1', { text: 'new' });
    expect(await justShown('b')).toBe('b');
    expect(state().doc.nodes[0]).toMatchObject({ text: 'new' });
  });

  it('shows the edit still being written to the other boards when the load ends', async () => {
    const { box, state, click, wait, justShown } = await start('a', 'c', 'b');
    await wait(200);
    box.delay = 900;
    click('b');
    await wait(10);
    state().updateNode('n1', { text: 'new' });
    expect(await justShown('b')).toBe('b');
    expect(state().doc.nodes[0]).toMatchObject({ text: 'new' });
  });

  it('shows the edit when a state from the history is opened over it before the load ends', async () => {
    const { backend, box, state, click, wait, justShown, keepState } = await start('a', 'b');
    const revision = await keepState();
    const readAtRequest = structuredClone(box.kept.get('b')!.doc);
    vi.spyOn(backend, 'load').mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return readAtRequest;
    });
    click('b');
    await wait(50);
    state().updateNode('n1', { text: 'new' });
    state().viewRevision(revision);
    expect(await justShown('b')).toBe('b');
    expect(state().doc.nodes[0]).toMatchObject({ text: 'new' });
  });
});
