import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blank } from './helpers';
import type { DeviceNode } from '../src/model/types';
import { stubPage, versionedDisk } from './page';
import { makeImage, makeNode } from '../src/model/presets';

let page: ReturnType<typeof stubPage>;
beforeEach(() => { page = stubPage(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('independent edit sessions', () => {
  it('continues migrating boards when an embedded image cannot be stored', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession({ page: true });
    const image = makeImage(new Set(), { src: 'data:image/png;base64,AA==', w: 10, h: 10, name: 'Picture' }, 0, 0);
    const broken = { ...blank('bad'), nodes: [image] };
    const next = { ...blank('good'), meta: { title: 'Migrated', project: '' } };
    page.storage.set('keito:boards', JSON.stringify([broken, next].map((d) => ({ id: d.id, title: d.meta.title, project: '', updated: 0 }))));
    page.storage.set('keito:board:bad', JSON.stringify(broken));
    page.storage.set('keito:board:good', JSON.stringify(next));
    const { backend, box } = versionedDisk([blank('aaa')]);
    backend.assets = true;
    backend.putAsset = async () => { throw new Error('asset unavailable'); };
    try {
      await session.boot(backend);
      expect(box.kept.get('good')?.doc.meta.title).toBe('Migrated');
      expect(session.useStore.getState().ready).toBe(true);
      expect(session.useStore.getState().saving).toBe('saved');
      expect(session.currentBoard().id).toBe('aaa');
    } finally {
      session.dispose();
    }
  });

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

  it('leaves a deleted board after switching away and back while removal is pending', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([
      { ...blank('aaa'), meta: { title: 'A', project: 'P' } },
      { ...blank('bbb'), meta: { title: 'B', project: 'P' } },
    ]);
    const remove = backend.remove;
    backend.remove = async (id) => { await new Promise((r) => setTimeout(r, 100)); await remove(id); };
    try {
      await session.boot(backend);
      const s = () => session.useStore.getState();
      s().deleteBoard('aaa');
      s().openBoard('bbb');
      await vi.advanceTimersByTimeAsync(10);
      expect(s().doc.id).toBe('bbb');
      expect(s().others.map((d) => d.id)).toContain('aaa');
      s().openBoard('aaa');
      await vi.advanceTimersByTimeAsync(10);
      expect(s().doc.id).toBe('aaa');
      await vi.advanceTimersByTimeAsync(200);
      expect(box.kept.has('aaa')).toBe(false);
      expect(s().doc.id).toBe('bbb');
      expect(s().others.map((d) => d.id)).not.toContain('aaa');
    } finally {
      session.dispose();
    }
  });

  it('removes a deleted revision from its board after switching away during removal', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend, box } = versionedDisk([
      { ...blank('aaa'), revisions: [{ id: 'old', at: '2026-11-10T00:00:00.000Z', name: 'Earlier' }] },
      blank('bbb'),
    ]);
    const remove = backend.removeRevision;
    backend.removeRevision = async (board, id) => { await new Promise((r) => setTimeout(r, 100)); await remove(board, id); };
    try {
      await session.boot(backend);
      const s = () => session.useStore.getState();
      s().deleteRevision('old');
      s().openBoard('bbb');
      await vi.advanceTimersByTimeAsync(10);
      expect(s().doc.id).toBe('bbb');
      await vi.advanceTimersByTimeAsync(200);
      s().openBoard('aaa');
      await vi.advanceTimersByTimeAsync(10);
      expect(s().doc.id).toBe('aaa');
      expect(s().doc.revisions?.map((r) => r.id)).not.toContain('old');
      expect(box.kept.get('aaa')?.doc.revisions?.map((r) => r.id)).not.toContain('old');
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
      box.notify({ id: 'aaa', serial: 2 });
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
      s().checkpoint({ origin, board: 'aaa' });
      s().mutate((d) => ({ ...d, meta: { ...d.meta, title: 'Committed' } }), false);
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
      const text = { ...makeNode('text', 0, 0, new Set()), text: '' };
      s().mutate((d) => ({ ...d, nodes: [...d.nodes, text] }));
      s().setEditing(text.id);
      s().updateNode(text.id, { h: 120 }, false);
      s().updateNode(text.id, { text: 'First words' }, false);
      s().setEditing(null);
      expect(phases.at(-1)).toEqual({ phase: 'begin', origin: 'local', board: 'aaa' });
      s().undo();
      expect(s().doc.nodes).toEqual([]);
      s().redo();
      expect(s().doc.nodes).toMatchObject([{ id: text.id, text: 'First words', h: 120 }]);
      s().dropStep();
      // A closed step still rolls back, without reporting another cancellation.
      expect(phases.at(-1)).toEqual({ phase: 'commit', origin: 'local', board: 'aaa' });
      s().mutate((d) => ({ ...d, nodes: [...d.nodes, text] }));
      s().setEditing(text.id);
      s().setEditing(null);
      s().dropStep();
      expect(phases.slice(-2)).toEqual([
        { phase: 'begin', origin: 'local', board: 'aaa' },
        { phase: 'cancel', origin: 'local', board: 'aaa' },
      ]);
      expect(s().doc.nodes).toEqual([]);
      await session.saveNow();
      expect(box.kept.get('aaa')?.doc.meta.title).toBe('Committed');
      stop();
    } finally {
      session.dispose();
    }
  });

  it('keeps what was undone to redo when a drag begun after the undo is called off', async () => {
    const { createEditSession } = await import('../src/model/store');
    const session = createEditSession();
    const { backend } = versionedDisk([blank('aaa')]);
    try {
      await session.boot(backend);
      const s = () => session.useStore.getState();
      const box = { ...makeNode('rect', 0, 0, new Set()), x: 0, y: 0 };
      s().mutate((d) => ({ ...d, nodes: [box] }));
      s().updateNode(box.id, { x: 100 });
      s().undo();
      s().checkpoint();
      s().updateNode(box.id, { y: 50 }, false);
      s().dropStep();
      expect(s().doc.nodes).toMatchObject([{ x: 0, y: 0 }]);
      s().redo();
      expect(s().doc.nodes).toMatchObject([{ x: 100, y: 0 }]);
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
    await vi.advanceTimersByTimeAsync(180_000);
    // A write already sent can finish, but cannot restart work or alter the closed editor.
    expect(box.kept.get('aaa')?.doc.meta.title).toBe('Sent before close');
    expect(box.kept.get('aaa')?.serial).toBe(2);
    expect(session.currentBoard()).toEqual(doc);
  });

  it('does not finish an old project push after switching boards', async () => {
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

});
