import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blank } from './helpers';
import type { DeviceNode } from '../src/model/types';
import { stubPage, versionedDisk } from './page';
import { makeNode } from '../src/model/presets';

let page: ReturnType<typeof stubPage>;
beforeEach(() => { page = stubPage(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('independent edit sessions', () => {
  it('opening a board survives deleting another one meanwhile', async () => {
    const { boot, useStore, defaultSession } = await import('../src/model/store');
    const { backend, box } = versionedDisk([blank('aaa'), blank('bbb'), blank('ccc')]);
    try {
      await boot(backend);
      const first = useStore.getState().doc.id;
      const target = ['aaa', 'bbb', 'ccc'].find((id) => id !== first && id !== 'ccc')!;
      box.delay = 100;
      useStore.getState().openBoard(target);
      await vi.advanceTimersByTimeAsync(10);
      useStore.getState().deleteBoard('ccc');
      await vi.advanceTimersByTimeAsync(500);
      expect(useStore.getState().doc.id).toBe(target);

      useStore.getState().newBoard({ ...blank('ddd'), meta: { title: 'New', project: '' } });
      await vi.advanceTimersByTimeAsync(10);
      useStore.getState().deleteBoard(first);
      await vi.advanceTimersByTimeAsync(500);
      expect(useStore.getState().doc.id).toBe('ddd');
      expect(box.kept.get('ddd')?.doc.meta.title).toBe('New');
    } finally {
      defaultSession.dispose();
    }
  });

  it('the deleted board leaves the list even when another board opens meanwhile', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { boot, useStore } = session;
    const { backend, box } = versionedDisk([blank('aaa'), blank('bbb'), blank('ccc')]);
    try {
      await boot(backend);
      const first = useStore.getState().doc.id;
      const target = ['aaa', 'bbb', 'ccc'].find((id) => id !== first && id !== 'ccc')!;
      const slowRemove = backend.remove;
      backend.remove = async (id) => { await new Promise((r) => setTimeout(r, 50)); return slowRemove(id); };
      box.delay = 20;
      useStore.getState().deleteBoard('ccc');
      useStore.getState().openBoard(target);
      await vi.advanceTimersByTimeAsync(500);
      expect(useStore.getState().doc.id).toBe(target);
      expect(useStore.getState().boards.map((b) => b.id)).not.toContain('ccc');
    } finally {
      session.dispose();
    }
  });

  it('keeps editing, selection, undo and saving on their own boards', async () => {
    const { createEditSession } = await import('../src/model/store');
    const left = createEditSession();
    const right = createEditSession();
    const shape = makeNode('rect', 0, 0, new Set());
    const a = versionedDisk([{ ...blank('aaa'), meta: { title: 'A', project: 'P' }, nodes: [shape] }]);
    const b = versionedDisk([{ ...blank('aaa'), meta: { title: 'B', project: 'Q' }, nodes: [shape] }]);
    try {
      await left.boot(a.backend);
      await right.boot(b.backend);
      const l = () => left.useStore.getState();
      const r = () => right.useStore.getState();
      l().select([shape.id]);
      expect(left.copySelection()).toBe(true);
      right.pasteClipboard();
      expect(r().doc.nodes).toHaveLength(1);
      left.duplicateSelection();
      l().undo();
      expect(l().doc.nodes).toHaveLength(1);
      l().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'A edited' } }));
      expect(l().saving).toBe('saving');
      expect(r().doc.meta.title).toBe('B');
      expect(r().selection).toEqual([]);
      expect(r().saving).toBe('saved');
      r().undo();
      expect(r().doc.meta.title).toBe('B');
      r().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'B edited' } }));
      l().undo();
      expect(l().doc.meta.title).toBe('A');
      expect(r().doc.meta.title).toBe('B edited');
      l().redo();
      await left.saveNow();
      await right.saveNow();
      expect(a.box.kept.get('aaa')?.doc.meta.title).toBe('A edited');
      expect(b.box.kept.get('aaa')?.doc.meta.title).toBe('B edited');
      expect(l().saving).toBe('saved');
      expect(r().saving).toBe('saved');
      // Updates received by one backend only reach its own editor.
      a.box.kept.set('aaa', { doc: { ...blank('aaa'), meta: { title: 'External A', project: 'P' } }, serial: 8 });
      a.box.notify({ id: 'aaa', serial: 8 });
      await vi.advanceTimersByTimeAsync(10);
      expect(l().doc.meta.title).toBe('External A');
      expect(r().doc.meta.title).toBe('B edited');
    } finally {
      left.dispose();
      right.dispose();
    }
  });

  it('stops a closed editor while the other editor keeps autosaving', async () => {
    const { createEditSession } = await import('../src/model/store');
    const left = createEditSession();
    const right = createEditSession();
    const a = versionedDisk([blank('aaa')]);
    const b = versionedDisk([blank('bbb')]);
    try {
      await left.boot(a.backend);
      await right.boot(b.backend);
      left.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Closed edit' } }));
      right.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Open edit' } }));
      left.dispose();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(a.box.kept.get('aaa')?.serial).toBe(1);
      expect(a.box.kept.get('aaa')?.doc.meta.title).toBe('');
      expect(b.box.kept.get('bbb')?.doc.meta.title).toBe('Open edit');
      expect(right.useStore.getState().saving).toBe('saved');
    } finally {
      left.dispose();
      right.dispose();
    }
  });

  it('ignores a late external read after opening another project', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([
      { ...blank('aaa'), meta: { title: 'A', project: 'P' } },
      { ...blank('bbb'), meta: { title: 'B', project: 'Q' } },
    ]);
    try {
      await session.boot(backend);
      box.kept.set('aaa', { doc: { ...blank('aaa'), meta: { title: 'External A', project: 'P' } }, serial: 2 });
      box.delay = 100;
      page.listeners.focus();
      await vi.advanceTimersByTimeAsync(10);
      box.delay = 0;
      session.useStore.getState().openBoard('bbb');
      await vi.advanceTimersByTimeAsync(10);
      expect(session.useStore.getState().doc.id).toBe('bbb');
      await vi.advanceTimersByTimeAsync(200);
      expect(session.useStore.getState().doc.meta.title).toBe('B');
      expect(session.useStore.getState().saving).toBe('saved');
      session.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'B edited' } }));
      await vi.advanceTimersByTimeAsync(600);
      expect(box.kept.get('bbb')?.doc.meta.title).toBe('B edited');
    } finally {
      session.dispose();
    }
  });

  it('keeps a new board when an earlier tab load finishes later', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([blank('aaa'), blank('bbb')]);
    try {
      await session.boot(backend);
      box.delay = 100;
      session.useStore.getState().openBoard('bbb');
      await vi.advanceTimersByTimeAsync(10);
      box.delay = 0;
      session.useStore.getState().newBoard({ ...blank('ccc'), meta: { title: 'New', project: '' } });
      await vi.advanceTimersByTimeAsync(10);
      expect(session.useStore.getState().doc.id).toBe('ccc');
      await vi.advanceTimersByTimeAsync(200);
      expect(session.useStore.getState().doc.id).toBe('ccc');
      expect(box.kept.get('ccc')?.doc.meta.title).toBe('New');
    } finally {
      session.dispose();
    }
  });

  it('reports operation phases with their origin and board through normal editing', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([blank('aaa')]);
    const origin = { source: 'local-editor' };
    const phases: { phase: string; origin: unknown; board: string }[] = [];
    try {
      await session.boot(backend);
      const stop = session.onOperation((event) => phases.push(event));
      const s = () => session.useStore.getState();
      s().beginOperation({ origin, board: 'aaa' });
      s().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Committed' } }), false);
      s().commitOperation();
      s().checkpoint({ origin, board: 'aaa' });
      s().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Cancelled' } }), false);
      s().dropStep();
      expect(phases).toEqual([
        { phase: 'begin', origin, board: 'aaa' },
        { phase: 'commit', origin, board: 'aaa' },
        { phase: 'begin', origin, board: 'aaa' },
        { phase: 'cancel', origin, board: 'aaa' },
      ]);
      expect(s().doc.meta.title).toBe('Committed');
      await session.saveNow();
      expect(box.kept.get('aaa')?.doc.meta.title).toBe('Committed');
      stop();
    } finally {
      session.dispose();
    }
  });

  it('does not finish booting or resume saving after disposal', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([blank('aaa')]);
    box.delay = 100;
    const booting = session.boot(backend);
    await vi.advanceTimersByTimeAsync(10);
    session.dispose();
    const doc = structuredClone(session.currentBoard());
    await vi.advanceTimersByTimeAsync(200);
    await booting;
    expect(session.currentBoard()).toEqual(doc);
    expect(session.useStore.getState().ready).toBe(false);
    expect(box.kept.get('aaa')?.serial).toBe(1);
  });

  it('ignores a delayed write and external notifications after disposal', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([blank('aaa')]);
    const save = backend.save;
    backend.save = async (doc) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await save(doc);
    };
    await session.boot(backend);
    session.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Sent before close' } }));
    await vi.advanceTimersByTimeAsync(501);
    session.dispose();
    const doc = structuredClone(session.currentBoard());
    box.notify({ id: 'aaa', serial: 5 });
    page.listeners.focus();
    await vi.advanceTimersByTimeAsync(180_000);
    // A write already sent can finish, but cannot restart work or alter the closed editor.
    expect(box.kept.get('aaa')?.doc.meta.title).toBe('Sent before close');
    expect(box.kept.get('aaa')?.serial).toBe(2);
    expect(session.currentBoard()).toEqual(doc);
  });

  it('does not finish an old project push after changing projects', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const node: DeviceNode = { id: 'pc', type: 'device', x: 0, y: 0, w: 160, h: 0, text: 'PC', maker: '', model: '', category: '', note: '', ports: [], shared: 'gear', sharedAt: 1 };
    const { backend, box } = versionedDisk([
      { ...blank('aaa'), meta: { title: 'A', project: 'P' }, nodes: [node] },
      { ...blank('bbb'), meta: { title: 'B', project: 'P' }, nodes: [node] },
      { ...blank('ccc'), meta: { title: 'C', project: 'Q' } },
    ]);
    try {
      await session.boot(backend);
      await vi.advanceTimersByTimeAsync(1);
      session.useStore.getState().updateNode(node.id, { text: 'Changed in P' });
      box.delay = 100;
      await vi.advanceTimersByTimeAsync(810);
      box.delay = 0;
      session.useStore.getState().openBoard('ccc');
      await vi.advanceTimersByTimeAsync(10);
      expect(session.useStore.getState().doc.id).toBe('ccc');
      await vi.advanceTimersByTimeAsync(200);
      expect(session.useStore.getState().doc.meta.title).toBe('C');
      expect(box.kept.get('bbb')?.doc.nodes[0].text).not.toBe('Changed in P');
    } finally {
      session.dispose();
    }
  });

  it('keeps the read version of an automatically connected backend per editor', async () => {
    const { createEditSession } = await import('../src/model/store');
    let saved = blank('aaa');
    let serial = 1;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/boards') return Response.json([{ id: 'aaa', title: saved.meta.title, updated: 0 }]);
      if (url === '/api/presets') return Response.json([]);
      if (url !== '/api/boards/aaa') return Response.json({});
      if (init?.method !== 'PUT') return Response.json({ ...saved, serial });
      const base = new Headers(init.headers).get('If-Match');
      if (base !== '*' && base !== String(serial)) return Response.json({ serial }, { status: 409 });
      saved = JSON.parse(String(init.body));
      return Response.json({ serial: ++serial });
    });
    const left = createEditSession();
    const right = createEditSession();
    try {
      await left.boot();
      await right.boot();
      right.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Right edit' } }));
      await right.saveNow();
      left.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Left edit' } }));
      await left.saveNow();
      expect(left.useStore.getState().saving).toBe('conflict');
      expect(saved.meta.title).toBe('Right edit');
      expect(right.useStore.getState().saving).toBe('saved');
    } finally {
      left.dispose();
      right.dispose();
    }
  });

  it('keeps tab undo and view history separate even with matching board ids', async () => {
    const { createEditSession } = await import('../src/model/store');
    const left = createEditSession();
    const right = createEditSession();
    const a = versionedDisk([{ ...blank('aaa'), meta: { title: 'A', project: '' } }, blank('bbb')]);
    const b = versionedDisk([{ ...blank('aaa'), meta: { title: 'B', project: '' } }, blank('bbb')]);
    try {
      await left.boot(a.backend);
      await right.boot(b.backend);
      left.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'A edited' } }));
      right.useStore.getState().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'B edited' } }));
      left.useStore.getState().setView({ x: 12, y: 34, k: 2 });
      right.useStore.getState().setView({ x: 50, y: 60, k: 1 });
      left.useStore.getState().openBoard('bbb');
      right.useStore.getState().openBoard('bbb');
      await vi.advanceTimersByTimeAsync(10);
      left.useStore.getState().openBoard('aaa');
      right.useStore.getState().openBoard('aaa');
      await vi.advanceTimersByTimeAsync(10);
      expect(left.useStore.getState().view).toEqual({ x: 12, y: 34, k: 2 });
      expect(right.useStore.getState().view).toEqual({ x: 50, y: 60, k: 1 });
      left.useStore.getState().undo();
      right.useStore.getState().undo();
      expect(left.useStore.getState().doc.meta.title).toBe('A');
      expect(right.useStore.getState().doc.meta.title).toBe('B');
    } finally {
      left.dispose();
      right.dispose();
    }
  });

  it('does not start image uploads when a closed editor finishes creating a board', async () => {
    const { createEditSession } = await import('../src/model/store');
    const { makeImage } = await import('../src/model/presets');
    const session = createEditSession();
    const { backend } = versionedDisk([blank('aaa')]);
    backend.assets = true;
    const save = backend.save;
    const images = new Map<string, string>();
    backend.save = async (doc) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await save(doc);
    };
    backend.putAsset = async (id, data) => { images.set(id, data); return 'asset:image.png'; };
    await session.boot(backend);
    session.useStore.getState().newBoard({ ...blank('bbb'), nodes: [makeImage(new Set(), { src: 'data:image/png;base64,AA==', w: 10, h: 10, name: 'Picture' }, 0, 0)] });
    await vi.advanceTimersByTimeAsync(10);
    session.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(images.size).toBe(0);
    expect(session.useStore.getState().doc.id).toBe('aaa');
  });
});
