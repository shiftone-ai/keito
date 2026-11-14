import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { allIds } from '../src/model/ids';
import { makeEdge, makeNode } from '../src/model/presets';
import type { TextAt, TextSession } from '../src/model/target';
import type { Node } from '../src/model/types';
import { type TextField, type TextRange, bindField } from '../src/ui/typing';
import { type RunningServer, seedData, startServer, until } from './collab';
import { blank } from './helpers';
import { stubPage, versionedDisk } from './page';

type Session = ReturnType<typeof import('../src/model/store').createEditSession>;

let data: string;
let seed: ProjectSeed;
let token: string;
let server: RunningServer;
const sessions: Session[] = [];

beforeEach(async () => {
  stubPage({ realTimers: true });
  ({ data, seed, token } = seedData());
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** An editor with its own local boards, showing the shared project's board. */
async function editor() {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession();
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: server.url, project: seed.id, token });
  const s = () => session.useStore.getState();
  const node = (id: string) => s().doc.nodes.find((n) => n.id === id);
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { s, node, stored };
}

type Editor = Awaited<ReturnType<typeof editor>>;

/**
 * Open a node's text to type into, as the canvas's editor does, in a field held in memory: what it
 * shows and what of it is selected. Typing changes the field, then tells the binding, as the
 * browser's input events do; a conversion (IME) changes the field while composing.
 */
function typeInto(e: Editor, id: string, joins = false, of: TextAt['field'] = 'text') {
  const session: TextSession = e.s().typeInto({ id, field: of }, joins)!;
  let text = session.value();
  let range: TextRange = [text.length, text.length];
  const field: TextField = { read: () => ({ text, range }), write: (t, r) => ((text = t), (range = r)) };
  const box = { gone: false };
  const typing = bindField(field, session, { gone: () => (box.gone = true) });
  const sorted = (): [number, number] => [Math.min(...range), Math.max(...range)];
  return Object.assign(box, {
    session,
    typing,
    shows: () => text,
    selected: () => range,
    select: (anchor: number, focus = anchor) => void (range = [anchor, focus]),
    /** Type `s` in place of what is selected. */
    type(s: string, composing = false) {
      const [from, to] = sorted();
      text = text.slice(0, from) + s + text.slice(to);
      range = [from + s.length, from + s.length];
      typing.input(composing);
    },
    backspace() {
      const [from, to] = sorted();
      const start = from === to ? from - 1 : from;
      text = text.slice(0, start) + text.slice(to);
      range = [start, start];
      typing.input(false);
    },
  });
}

const shape = () => seed.shape.id;
const textOf = (e: Editor, id = shape()) => e.node(id)?.text;
/** A pause longer than a burst of typing (half a second), which one undo while typing takes back. */
const pause = () => new Promise((r) => setTimeout(r, 600));

describe('typing into a shared board', () => {
  it('keeps what two editors type at different places of one name, each shown the other’s with the selection kept on what it was on, and sends nothing back of what it hears', async () => {
    const a = await editor();
    const b = await editor();
    const ta = typeInto(a, shape());
    const tb = typeInto(b, shape());
    // B has the last character of 図形 selected; A types in front of it all.
    tb.select(1, 2);
    ta.select(0);
    ta.type('A:');
    await until(() => tb.shows() === 'A:図形', 5_000, 'A’s typing in B’s field');
    expect(tb.selected()).toEqual([3, 4]);
    // What B only heard is no edit of B's.
    expect(b.s().collab).toMatchObject({ pending: 0, undo: false });

    tb.type('X');
    await until(() => ta.shows() === 'A:図X', 5_000, 'B’s typing in A’s field');
    ta.select(ta.shows().length);
    ta.type('!');
    // Put in at B's caret: B's caret stays before it, and what B types next goes there.
    await until(() => tb.shows() === 'A:図X!', 5_000, 'A’s second typing in B’s field');
    expect(tb.selected()).toEqual([4, 4]);
    tb.type('\n2行目');
    await until(() => ta.shows() === tb.shows() && textOf(a) === textOf(b) && textOf(a) === ta.shows(), 5_000, 'both fields to be the same');
    expect(ta.shows()).toBe('A:図X\n2行目!');
    tb.backspace();
    tb.select(2, 4);
    tb.backspace();
    await until(() => textOf(a) === 'A:\n2行!', 5_000, 'B’s deletions to reach A');
    expect(ta.shows()).toBe('A:\n2行!');
    await a.stored();
    await b.stored();
  });

  it('puts a conversion down where it was typed, the field left alone while it is under way and others’ typing shown once it is down', async () => {
    const a = await editor();
    const b = await editor();
    const ta = typeInto(a, shape());
    const tb = typeInto(b, shape());

    ta.typing.compositionStart();
    ta.type('かん', true);
    tb.select(0);
    tb.type('X');
    await until(() => textOf(a) === 'X図形', 5_000, 'B’s typing to reach A');
    expect(ta.shows()).toBe('図形かん');
    ta.select(2, 4);
    ta.type('漢', true);
    ta.typing.compositionEnd();
    await until(() => ta.shows() === 'X図形漢', 5_000, 'the conversion to be put down');
    expect(ta.selected()).toEqual([4, 4]);

    // Another key starts the next conversion as it puts this one down (as after a conversion by Space).
    ta.typing.compositionStart();
    ta.type('じ', true);
    ta.select(4, 5);
    ta.type('字', true);
    ta.typing.compositionEnd();
    ta.typing.compositionStart();
    await until(() => tb.shows() === 'X図形漢字', 5_000, 'A’s first conversions to reach B');
    tb.select(tb.shows().length);
    tb.type('Y');
    await until(() => textOf(a)?.endsWith('Y') ?? false, 5_000, 'B’s second typing to reach A');
    expect(textOf(a)).toBe('X図形漢字Y');
    ta.type('を', true);
    expect(ta.shows()).toBe('X図形漢字を');
    ta.typing.compositionEnd();
    await until(() => textOf(b) === 'X図形漢字をY', 5_000, 'the conversions to reach B');
    expect(ta.shows()).toBe('X図形漢字をY');
    expect(ta.selected()).toEqual([6, 6]);
  });

  it('undoes only what the editor typed, a burst at a time while typing and as one step after, and calls only that off on Escape', async () => {
    const a = await editor();
    const b = await editor();
    const ta = typeInto(a, shape());
    ta.type('あ');
    const tb = typeInto(b, shape());
    tb.select(0);
    tb.type('B');
    await until(() => ta.shows() === 'B図形あ', 5_000, 'B’s typing to reach A');
    await pause();
    ta.type('い');
    ta.typing.undo();
    expect(ta.shows()).toBe('B図形あ');
    ta.typing.redo();
    expect(ta.shows()).toBe('B図形あい');
    ta.typing.close();
    ta.session.end(true);

    a.s().undo();
    await until(() => textOf(b) === 'B図形', 5_000, 'A’s undo to reach B');
    expect(tb.shows()).toBe('B図形');
    a.s().redo();
    await until(() => textOf(b) === 'B図形あい', 5_000, 'A’s redo to reach B');

    // Called off: what A typed goes, B's typing meanwhile stays, and nothing is left to redo.
    const again = typeInto(a, shape());
    again.type('う');
    tb.select(0);
    tb.type('C');
    await until(() => again.shows() === 'CB図形あいう', 5_000, 'B’s typing to reach A again');
    again.typing.close();
    again.session.end(false);
    await until(() => textOf(b) === 'CB図形あい', 5_000, 'A’s calling off to reach B');
    expect(a.s().collab).toMatchObject({ redo: false, undo: true });
    a.s().undo();
    await until(() => textOf(b) === 'CB図形', 5_000, 'A’s undo of its first typing to reach B');
  });

  it('ends typing into a shape another editor takes off, without bringing it back', async () => {
    const a = await editor();
    const b = await editor();
    a.s().select([shape()]);
    const ta = typeInto(a, shape());
    ta.type('消える');
    await until(() => textOf(b) === '図形消える', 5_000, 'A’s typing to reach B');
    b.s().removeIds([shape()]);
    await until(() => ta.gone, 5_000, 'A’s typing to end');
    ta.type('まだ');
    ta.session.end(false);
    await a.stored();
    await b.stored();
    expect(a.node(shape())).toBeUndefined();
    expect(a.s().selection).toEqual([]);
    expect(b.node(shape())).toBeUndefined();
  });

  it('calls off a box just put down and left empty with the step that put it there, and keeps one typed into as one step with its text', async () => {
    const a = await editor();
    const b = await editor();
    /** Put a text box down as the toolbar does, and open it to type into (its text joins the step that put it there). */
    const put = (): { id: string; typing: ReturnType<typeof typeInto> } => {
      let made: Node | undefined;
      a.s().mutate((d) => {
        made = makeNode('text', 300, 200, allIds(d), '');
        return { ...d, nodes: [...d.nodes, made] };
      });
      return { id: made!.id, typing: typeInto(a, made!.id, true) };
    };

    const kept = put();
    kept.typing.type('メモ');
    kept.typing.session.end(true);
    await until(() => textOf(b, kept.id) === 'メモ', 5_000, 'the text box to reach B');

    const dropped = put();
    await until(() => !!b.node(dropped.id), 5_000, 'the empty box to reach B');
    dropped.typing.session.end(false);
    await until(() => !b.node(dropped.id), 5_000, 'the empty box to go from B');
    expect(a.s().collab?.redo).toBe(false);

    a.s().undo();
    await until(() => !b.node(kept.id), 5_000, 'the text box to go from B');
    a.s().redo();
    await until(() => textOf(b, kept.id) === 'メモ', 5_000, 'the text box to come back to B');
  });

  it('types into a line’s label and its note the same way, each editor’s letters kept', async () => {
    const a = await editor();
    const b = await editor();
    let line = '';
    a.s().mutate((d) => {
      const end = makeNode('ellipse', 400, 0, allIds(d), '受け');
      const made = makeEdge(new Set([...allIds(d), end.id]), { node: shape() }, { node: end.id }, 'flow');
      line = made.id;
      return { ...d, nodes: [...d.nodes, end], edges: [...d.edges, made] };
    });
    const edge = (e: Editor) => e.s().doc.edges.find((x) => x.id === line);
    await until(() => !!edge(b), 5_000, 'the line to reach B');

    const la = typeInto(a, line, false, 'label');
    const lb = typeInto(b, line, false, 'label');
    la.type('送る');
    await until(() => lb.shows() === '送る', 5_000, 'A’s label to reach B');
    lb.select(0);
    lb.type('先に');
    await until(() => la.shows() === '先に送る', 5_000, 'B’s label to reach A');
    la.type('！');
    await until(() => edge(b)?.label === '先に送る！', 5_000, 'both labels on B’s line');

    const note = typeInto(b, line, false, 'note');
    note.type('予備あり');
    await until(() => edge(a)?.note === '予備あり', 5_000, 'B’s note to reach A');
    for (const t of [la, lb, note]) t.session.end(true);
    await a.stored();
    await b.stored();
    expect(edge(a)).toMatchObject({ label: '先に送る！', note: '予備あり' });
  });
});
