import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { allIds } from '../src/model/ids';
import { makeDevice, makeEdge, makeImage, makeLegend, makeNode, presetOf } from '../src/model/presets';
import type { TextAt, TextSession } from '../src/model/target';
import type { DeviceNode, ImageNode, LegendNode, Node } from '../src/model/types';
import { type TextField, type TextRange, bindField } from '../src/ui/typing';
import { type RunningServer, seedData, startServer, storedEdits, until } from './collab';
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
 * Open a text of the board to type into (a node's own by its id), as the canvas's editor and the
 * inspector's fields do, in a field held in memory: what it shows and what of it is selected. Typing
 * changes the field, then tells the binding, as the browser's input events do; a conversion (IME)
 * changes the field while composing. `joins`: the typing is part of the editor's last step;
 * `oneLine`: the field shows the text on one line.
 */
function typeInto(e: Editor, at: string | TextAt, { joins = false, oneLine = false } = {}) {
  const session: TextSession = e.s().typeInto(typeof at === 'string' ? { id: at, field: 'text' } : at, joins)!;
  /** What the field shows of a text: `oneLine`, as an input does, a space for each line break. */
  const shows = (t: string): string => (oneLine ? t.replace(/\n/g, ' ') : t);
  let text = shows(session.value());
  let range: TextRange = [text.length, text.length];
  const field: TextField = { read: () => ({ text, range }), write: (t, r) => ((text = shows(t)), (range = r)) };
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
      return { id: made!.id, typing: typeInto(a, made!.id, { joins: true }) };
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

    const la = typeInto(a, { id: line, field: 'label' });
    const lb = typeInto(b, { id: line, field: 'label' });
    la.type('送る');
    await until(() => lb.shows() === '送る', 5_000, 'A’s label to reach B');
    lb.select(0);
    lb.type('先に');
    await until(() => la.shows() === '先に送る', 5_000, 'B’s label to reach A');
    la.type('！');
    await until(() => edge(b)?.label === '先に送る！', 5_000, 'both labels on B’s line');

    const note = typeInto(b, { id: line, field: 'note' });
    note.type('予備あり');
    await until(() => edge(a)?.note === '予備あり', 5_000, 'B’s note to reach A');
    for (const t of [la, lb, note]) t.session.end(true);
    await a.stored();
    await b.stored();
    expect(edge(a)).toMatchObject({ label: '先に送る！', note: '予備あり' });
  });
});

/** Put `made` on the board `e` shows, in one step, and wait for the other editors to have it. */
async function putNode<T extends Node>(e: Editor, made: (taken: Set<string>) => T, others: Editor[]): Promise<T> {
  let node!: T;
  e.s().mutate((d) => {
    node = made(allIds(d));
    return { ...d, nodes: [...d.nodes, node] };
  });
  for (const other of others) await until(() => !!other.node(node.id), 5_000, 'the node to reach the other editor');
  return node;
}

/** Take the server away, so that no editor hears of another's edits, until it is started again on the same port. */
async function cutOff(...editors: Editor[]): Promise<() => Promise<void>> {
  const { port } = server;
  await server.kill();
  await until(() => editors.every((e) => e.s().collab?.link === 'offline'), 5_000, 'the server to be missed');
  return async () => void (server = await startServer(data, port));
}

describe('typing into the texts the inspector shows of a shared board', () => {
  it('types into a device’s note and the name of one of its ports, each editor’s letters kept, and undo takes back only the editor’s own', async () => {
    const a = await editor();
    const b = await editor();
    const pc = await putNode(a, (taken) => makeDevice(presetOf('pc')!, 300, 0, taken), [b]);
    const port = pc.ports[0];
    const device = (e: Editor) => e.node(pc.id) as DeviceNode | undefined;
    const portName = (e: Editor) => device(e)?.ports.find((p) => p.id === port.id)?.name;

    const note = typeInto(b, { id: pc.id, field: 'note' });
    note.type('予備機');
    note.session.end(true);
    const mine = typeInto(a, { id: pc.id, field: 'port', port: port.id });
    const theirs = typeInto(b, { id: pc.id, field: 'port', port: port.id });
    mine.select(0);
    mine.type('本線 ');
    theirs.type(' 2');
    await until(() => mine.shows() === `本線 ${port.name} 2` && theirs.shows() === mine.shows(), 5_000, 'both names of the port to be the same');
    for (const t of [mine, theirs]) t.session.end(true);
    for (const e of [a, b]) await until(() => device(e)?.note === '予備機' && portName(e) === `本線 ${port.name} 2`, 5_000, 'the note and the port’s name on each editor');

    a.s().undo();
    await until(() => portName(b) === `${port.name} 2`, 5_000, 'A’s undo of the port’s name to reach B');
    expect(device(b)?.note).toBe('予備機');
  });

  it('keeps a line break of a text typed into in a field of one line, where a space stands for it, through what is typed beside it there and by another editor', async () => {
    const a = await editor();
    const b = await editor();
    const board = typeInto(a, shape());
    board.type('\n下');
    await until(() => textOf(b) === '図形\n下', 5_000, 'the line break to reach B');

    const line = typeInto(b, shape(), { oneLine: true });
    expect(line.shows()).toBe('図形 下');
    line.select(0);
    line.type('X');
    await until(() => board.shows() === 'X図形\n下', 5_000, 'B’s letter in front of the line break');
    board.type('Y');
    await until(() => line.shows() === 'X図形 下Y', 5_000, 'A’s letter in B’s field');
    line.select(line.shows().length);
    line.type('Z');
    await until(() => board.shows() === 'X図形\n下YZ', 5_000, 'B’s letter after A’s, the line break kept');
    expect(textOf(b)).toBe('X図形\n下YZ');
  });

  it('keeps the letters of two editors who each begin a picture’s caption and leave it before hearing of the other', async () => {
    const a = await editor();
    const b = await editor();
    const picture = await putNode(a, (taken) => makeImage(taken, { src: `shared:${'0123456789ab'.repeat(2)}.png`, w: 200, h: 100, name: '会場' }, 300, 300) as ImageNode, [b]);
    const captionOf = (e: Editor) => (e.node(picture.id) as ImageNode | undefined)?.caption;
    await a.stored();

    const backOn = await cutOff(a, b);
    for (const [e, letters] of [[a, '1F'], [b, '会場図']] as const) {
      const caption = typeInto(e, { id: picture.id, field: 'caption' });
      caption.type(letters);
      caption.session.end(true);
    }
    await backOn();
    await until(() => !!captionOf(a) && captionOf(a) === captionOf(b), 15_000, 'both editors to show one caption');
    expect(['1F会場図', '会場図1F']).toContain(captionOf(a));
  });

  it('puts the name a legend gives a row there with the first thing typed, not by opening it; two who begin it at once keep both their letters as they type on, and each undoes its own', async () => {
    const a = await editor();
    const b = await editor();
    const legend = await putNode(a, (taken) => makeLegend(taken, 600, 0) as LegendNode, [b]);
    const at: TextAt = { id: legend.id, field: 'row', row: '#2563eb' };
    const names = (e: Editor) => (e.node(legend.id) as LegendNode | undefined)?.names;
    const name = (e: Editor) => names(e)?.[at.row];
    await a.stored();
    const stored = storedEdits(data, seed.id);

    const mine = typeInto(a, at);
    const theirs = typeInto(b, at);
    expect(mine.shows()).toBe('');
    expect(a.s().collab?.pending).toBe(0);
    expect(storedEdits(data, seed.id)).toBe(stored);

    const backOn = await cutOff(a, b);
    mine.type('映像');
    theirs.type('本線');
    await backOn();
    await until(() => !!name(a) && name(a) === name(b) && mine.shows() === name(a) && theirs.shows() === name(a), 15_000, 'both editors and both fields to show one name');
    expect(['映像本線', '本線映像']).toContain(name(a));
    expect([mine.gone, theirs.gone]).toEqual([false, false]);
    mine.select(mine.shows().length);
    mine.type('！');
    await until(() => theirs.shows() === mine.shows() && name(b)?.endsWith('！') === true, 5_000, 'A’s next letter to reach B');
    for (const t of [mine, theirs]) t.session.end(true);

    a.s().undo();
    await until(() => name(a) === '本線' && name(b) === '本線', 5_000, 'A’s undo to leave B’s letters');
    b.s().undo();
    // A name emptied is no name: the row goes by its usual one again.
    await until(() => names(a) === undefined && names(b) === undefined, 5_000, 'the name to be empty again');
    await a.stored();
    await b.stored();
  });

  it('ends typing into a port’s name when another editor takes the port off, and into a text that is not of the board, without bringing anything back', async () => {
    const a = await editor();
    const b = await editor();
    const pc = await putNode(a, (taken) => makeDevice(presetOf('pc')!, 300, 0, taken), [b]);
    const port = pc.ports[0];
    const ports = (e: Editor) => (e.node(pc.id) as DeviceNode | undefined)?.ports.map((p) => p.id);
    const typing = typeInto(a, { id: pc.id, field: 'port', port: port.id });
    typing.type('消える');
    await until(() => (b.node(pc.id) as DeviceNode | undefined)?.ports[0].name === `${port.name}消える`, 5_000, 'A’s typing to reach B');
    b.s().updateNode(pc.id, { ports: pc.ports.slice(1) });
    await until(() => typing.gone, 5_000, 'A’s typing to end');
    typing.type('まだ');
    typing.session.end(true);
    await a.stored();
    await b.stored();
    expect(ports(a)).toEqual(pc.ports.slice(1).map((p) => p.id));
    expect(ports(b)).toEqual(ports(a));

    // No text to type into: a port the device does not have, a caption of what is no picture, a row of what is no legend.
    const s = a.s();
    expect(s.typeInto({ id: pc.id, field: 'port', port: port.id }, false)).toBeNull();
    expect(s.typeInto({ id: pc.id, field: 'caption' }, false)).toBeNull();
    expect(s.typeInto({ id: shape(), field: 'row', row: '#2563eb' }, false)).toBeNull();
  });
});
