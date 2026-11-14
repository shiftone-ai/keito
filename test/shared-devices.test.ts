import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSeed } from '../src/collab/model';
import { allIds } from '../src/model/ids';
import { networkTable } from '../src/model/lists';
import { makeDevice, makeEdge, presetOf } from '../src/model/presets';
import { catalog } from '../src/model/shared';
import type { DeviceNode, Doc } from '../src/model/types';
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
  ({ data, seed, token } = seedData('system'));
  server = await startServer(data);
});

afterEach(async () => {
  sessions.splice(0).forEach((s) => s.dispose());
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** An editor on a page of its own, showing the shared project (its system board first). */
async function editor() {
  const { createEditSession } = await import('../src/model/store');
  const session = createEditSession();
  sessions.push(session);
  const disk = versionedDisk([{ ...blank('local'), meta: { title: 'ローカル', project: '' } }]);
  await session.boot(disk.backend);
  await session.openCollab({ server: server.url, project: seed.id, token });
  const s = () => session.useStore.getState();
  /** A board of the project as this editor has it: the one on screen, or another (see State.others). */
  const board = (id = s().doc.id): Doc | undefined => (id === s().doc.id ? s().doc : s().others.find((d) => d.id === id));
  const device = (id: string, on?: string) => board(on)?.nodes.find((n) => n.id === id) as DeviceNode | undefined;
  /** Put a device on the board on screen as the library does, in one step. */
  const add = (key: string, x = 0, y = 0): DeviceNode => {
    let made: DeviceNode | undefined;
    s().mutate((d) => {
      made = makeDevice(presetOf(key)!, x, y, allIds(d));
      return { ...d, nodes: [...d.nodes, made] };
    });
    return made!;
  };
  /** Pull a line from the first output of one device to the first input of another, in one step. */
  const wire = (from: DeviceNode, to: DeviceNode) =>
    s().mutate((d) => {
      const out = from.ports.find((p) => p.side === 'right')!;
      const into = to.ports.find((p) => p.side === 'left')!;
      return { ...d, edges: [...d.edges, makeEdge(allIds(d), { node: from.id, port: out.id }, { node: to.id, port: into.id }, out.signal)] };
    });
  /** A device of another board as the inspector offers it to be linked to (see SharedSection). */
  const entry = (on: string, id: string) => catalog([s().doc, ...s().others]).find((e) => e.board === on && e.node.id === id)!;
  /** Add a board to the project, which is opened. */
  const addBoard = (title: string, kind: 'system' | 'software' = 'system'): string => {
    s().collab!.manage.add(title, kind);
    return s().doc.id;
  };
  const stored = () => until(() => s().saving === 'saved' && s().collab?.pending === 0, 5_000, 'the edits to be stored');
  return { session, s, board, device, add, wire, entry, addBoard, stored };
}
type Editor = Awaited<ReturnType<typeof editor>>;

/** Kill the server outright, start it again over the same data, and open the project in a new editor. */
async function afterRestart(): Promise<Editor> {
  await server.kill();
  server = await startServer(data);
  return editor();
}

/** What a device's network row shows: its name, host name and IP. */
function networkRow(doc: Doc, id: string): string[] | undefined {
  const table = networkTable(doc);
  return table.rows[table.refs.findIndex((r) => r.includes(id))]?.slice(0, 3);
}

/**
 * A PC on the system board, and on a second system board the same PC, linked to it there as the
 * inspector does: a editor on the second board, b on the first.
 */
async function onTwoBoards() {
  const a = await editor();
  const b = await editor();
  const pc = a.add('pc', 300, 0);
  const back = a.addBoard('裏');
  const twin = a.add('pc');
  a.s().linkTo(twin.id, a.entry(seed.board.id, pc.id));
  const key = a.device(twin.id)?.shared;
  expect(key).toBeTruthy();
  await until(() => b.device(pc.id)?.shared === key && !!b.board(back), 5_000, 'the link to reach the other editor');
  return { a, b, pc, twin, back, key: key! };
}

describe('a device placed on boards of a shared project as one shared device', () => {
  it('keeps the name changed on one board and the IP changed on the other, on every board, while each board keeps where its device is and its colour; through a killed server', async () => {
    const { a, b, pc, twin, back } = await onTwoBoards();
    expect(a.device(twin.id)).toMatchObject({ text: pc.text, category: pc.category });

    // At once: one renames it and colours it on the system board, the other gives it an IP and moves it on the second.
    b.s().updateNode(pc.id, { text: 'メインPC' });
    b.s().updateNode(pc.id, { color: 'blue' });
    a.s().updateNode(twin.id, { ip: '192.168.0.10', host: 'main-pc' });
    a.s().updateNode(twin.id, { x: 40, y: 80 });

    for (const x of [a, b]) {
      for (const [id, on] of [[pc.id, seed.board.id], [twin.id, back]])
        await until(() => x.device(id, on)?.text === 'メインPC' && x.device(id, on)?.ip === '192.168.0.10', 5_000, 'both changes on each board of each editor');
      // Each step is sent on its own: the colour and the move may come after the name and the IP.
      await until(() => x.device(pc.id, seed.board.id)?.color === 'blue' && x.device(twin.id, back)?.x === 40, 5_000, 'the colour and the move to reach each editor');
    }
    for (const x of [a, b]) {
      expect(x.device(pc.id, seed.board.id)).toMatchObject({ x: 300, y: 0, color: 'blue', host: 'main-pc' });
      expect(x.device(twin.id, back)).toMatchObject({ x: 40, y: 80, host: 'main-pc' });
      expect(x.device(twin.id, back)?.color).not.toBe('blue');
    }
    await a.stored();
    await b.stored();

    const c = await afterRestart();
    expect(c.device(pc.id, seed.board.id)).toMatchObject({ text: 'メインPC', ip: '192.168.0.10', host: 'main-pc', x: 300, color: 'blue' });
    expect(c.device(twin.id, back)).toMatchObject({ text: 'メインPC', ip: '192.168.0.10', host: 'main-pc', x: 40 });
  });

  it('unlinks one placement, which keeps what it had, leaving the other placements and the other shared devices as they are; deleting a placement keeps the shared device for another', async () => {
    const { a, b, pc, twin, back } = await onTwoBoards();
    const pj = b.add('pj', 600, 0);
    await until(() => !!a.device(pj.id, seed.board.id), 5_000, 'the projector to reach the other editor');
    const pjTwin = a.add('pj', 300, 200);
    a.s().linkTo(pjTwin.id, a.entry(seed.board.id, pj.id));
    const pjKey = a.device(pjTwin.id)!.shared;
    await until(() => b.device(pj.id)?.shared === pjKey, 5_000, 'the projector link to reach the other editor');

    a.s().unlink(twin.id);
    expect(a.device(twin.id)).toMatchObject({ text: pc.text, category: pc.category });
    expect(a.device(twin.id)?.shared).toBeUndefined();
    await until(() => !!b.device(twin.id, back) && !b.device(twin.id, back)?.shared, 5_000, 'the unlink to reach the other editor');
    // What the system board's PC becomes is no longer the unlinked one's, nor the projector's.
    b.s().updateNode(pc.id, { text: 'メインPC', ip: '192.168.0.10' });
    b.s().updateNode(pj.id, { ip: '192.168.0.20' });
    await until(() => a.device(pjTwin.id)?.ip === '192.168.0.20' && a.device(pc.id, seed.board.id)?.ip === '192.168.0.10', 5_000, 'the changes to reach the other editor');
    expect(a.device(twin.id)?.text).toBe(pc.text);
    expect(a.device(twin.id)?.ip).toBeUndefined();
    expect(a.device(pc.id, seed.board.id)).toMatchObject({ text: 'メインPC', shared: b.device(pc.id)!.shared });
    expect(a.device(pjTwin.id)).toMatchObject({ text: pj.text, shared: pjKey });

    // A placement deleted: the shared device stays, on its other board and to be placed again.
    a.s().removeIds([pjTwin.id]);
    const again = a.add('pj', 0, 400);
    a.s().linkTo(again.id, a.entry(seed.board.id, pj.id));
    expect(a.device(again.id)).toMatchObject({ shared: pjKey, ip: '192.168.0.20' });
    await until(() => !!b.device(again.id, back), 5_000, 'the new placement to reach the other editor');
    expect(b.device(pj.id)).toMatchObject({ shared: pjKey, ip: '192.168.0.20' });
    await a.stored();

    const c = await afterRestart();
    expect(c.device(twin.id, back)?.text).toBe(pc.text);
    expect(c.device(twin.id, back)?.shared).toBeUndefined();
    expect(c.device(again.id, back)).toMatchObject({ shared: pjKey, ip: '192.168.0.20' });
    expect(c.device(pjTwin.id, back)).toBeUndefined();
  });

  it('deletes a shared device once the user agrees to what goes with it, from every board with its ports and lines, and one undo brings it all back; through a killed server', async () => {
    const { a, b, pc, twin, back } = await onTwoBoards();
    const pj = b.add('pj', 600, 0);
    b.wire(pc, pj);
    const screen = a.add('pj', 300, 0);
    a.wire(twin, screen);
    await until(() => a.board(seed.board.id)?.edges.length === 1 && b.board(back)?.edges.length === 1, 5_000, 'the lines to reach each editor');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    a.s().deleteSharedDevice(twin.id);
    await until(() => confirm.mock.calls.length === 1, 5_000, 'the user to be asked');
    const said = String(confirm.mock.calls[0][0]);
    expect(said).toContain(pc.text);
    expect(said).toContain(`2 枚のボードにある「${pc.text}」2 個`);
    expect(said).toContain(`ポート ${pc.ports.length * 2} 個`);
    expect(said).toContain('線 2 本');
    expect(a.device(twin.id)).toBeDefined();

    a.s().deleteSharedDevice(twin.id);
    await until(() => !a.device(twin.id), 5_000, 'the shared device to be deleted');
    for (const x of [a, b]) {
      await until(() => !x.device(pc.id, seed.board.id) && !x.device(twin.id, back), 5_000, 'its placements to leave each board of each editor');
      expect(x.board(seed.board.id)?.edges).toEqual([]);
      expect(x.board(back)?.edges).toEqual([]);
      expect(x.device(pj.id, seed.board.id)).toBeDefined();
      expect(x.device(screen.id, back)).toBeDefined();
    }

    a.s().undo();
    for (const x of [a, b])
      await until(() => !!x.device(pc.id, seed.board.id) && !!x.device(twin.id, back) && x.board(seed.board.id)?.edges.length === 1 && x.board(back)?.edges.length === 1, 5_000, 'the undo to bring it all back on each editor');
    expect(b.device(pc.id)).toMatchObject({ text: pc.text, shared: a.device(twin.id)!.shared });
    await a.stored();

    const c = await afterRestart();
    expect(c.device(pc.id, seed.board.id)).toMatchObject({ text: pc.text });
    expect(c.board(back)?.edges).toHaveLength(1);
  });

  it('gives software the host name and IP of the device it runs on as that device has them now, as the system board lists it; a host the project no longer has is tied to no other device', async () => {
    const a = await editor();
    const b = await editor();
    const pc = a.add('pc', 300, 0);
    a.s().updateNode(pc.id, { ip: '192.168.0.10' });
    // Of the same name, on the same board: never taken for the host once it is gone.
    const namesake = a.add('pc', 300, 300);
    a.s().updateNode(namesake.id, { ip: '192.168.0.99', host: 'other' });
    const soft = a.addBoard('ソフト', 'software');
    const td = a.add('td');
    a.s().runOn(td.id, a.entry(seed.board.id, pc.id));
    expect(a.device(td.id)).toMatchObject({ runsOn: a.device(pc.id, seed.board.id)!.shared, host: pc.text, ip: '192.168.0.10' });

    await until(() => !!b.device(pc.id)?.shared, 5_000, 'the host to reach the other editor');
    b.s().updateNode(pc.id, { ip: '192.168.0.11', host: 'main-pc' });
    await until(() => a.device(td.id)?.ip === '192.168.0.11', 5_000, 'the new IP to reach the software');
    expect(a.device(td.id)?.host).toBe('main-pc');
    // The software board lists it as the system board lists its host, on either editor.
    await until(() => b.device(td.id, soft)?.ip === '192.168.0.11', 5_000, 'the software to reach the other editor');
    expect(networkRow(a.board(soft)!, td.id)?.slice(1)).toEqual(networkRow(b.board(seed.board.id)!, pc.id)?.slice(1));
    expect(networkRow(b.board(soft)!, td.id)).toEqual([td.text, 'main-pc', '192.168.0.11']);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    b.s().deleteSharedDevice(pc.id);
    await until(() => !a.device(pc.id, seed.board.id), 5_000, 'the host to be deleted');
    expect(String(confirm.mock.calls[0][0])).toContain('動作ホストにしているソフトウェア 1 個');
    for (const x of [a, b]) {
      await until(() => !x.device(pc.id, seed.board.id), 5_000, 'the host to leave each editor');
      expect(x.device(td.id, soft)).toMatchObject({ host: undefined, ip: undefined });
      expect(x.device(td.id, soft)?.runsOn).toBeTruthy();
    }
    expect(networkRow(a.board(soft)!, td.id)).toBeUndefined();
  });

  it('pastes a device copied from another board of the project as the same shared device, and a second on the same board as another device', async () => {
    const { a, pc, key } = await onTwoBoards();
    const third = a.addBoard('客席');
    a.s().openBoard(seed.board.id);
    a.s().select([pc.id]);
    expect(a.session.copySelection()).toBe(true);
    a.s().openBoard(third);
    a.session.pasteClipboard();
    const [copy] = a.s().selection;
    expect(a.device(copy)).toMatchObject({ shared: key, text: pc.text });
    a.session.pasteClipboard();
    const [second] = a.s().selection;
    expect(second).not.toBe(copy);
    expect(a.device(second)?.text).toBe(pc.text);
    expect(a.device(second)?.shared).toBeUndefined();
  });

  it("undoes this page's own step on the board on screen, a shared device's particulars with it, never a step made on another board or by someone else", async () => {
    const { a, b, pc, twin, back } = await onTwoBoards();
    a.s().openBoard(seed.board.id);
    // One step: the PC moved and given an IP.
    a.s().mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === pc.id ? { ...n, x: 500, ip: '192.168.0.10' } : n)) }));
    a.s().openBoard(back);
    a.s().updateNode(twin.id, { text: 'メインPC' });
    b.s().updateNode(pc.id, { maker: 'Apple' });
    await until(() => a.device(twin.id)?.maker === 'Apple' && b.device(pc.id)?.text === 'メインPC', 5_000, "each editor's change to reach the other");

    a.s().openBoard(seed.board.id);
    a.s().undo();
    expect(a.device(pc.id)).toMatchObject({ x: 300, ip: undefined, text: 'メインPC', maker: 'Apple' });
    await until(() => b.device(pc.id)?.x === 300, 5_000, 'the undo to reach the other editor');
    expect(b.device(pc.id)).toMatchObject({ ip: undefined, text: 'メインPC', maker: 'Apple' });

    a.s().openBoard(back);
    a.s().undo();
    expect(a.device(twin.id)).toMatchObject({ text: pc.text, maker: 'Apple' });
    await until(() => b.device(pc.id)?.text === pc.text, 5_000, 'the second undo to reach the other editor');
    expect(b.device(pc.id)).toMatchObject({ x: 300, maker: 'Apple' });
  });

  it('types the name of a device placed on two boards into the shared device: the other board shows each letter, and undo takes back only what was typed', async () => {
    const { a, b, pc, twin } = await onTwoBoards();
    const typing = a.s().typeInto({ id: twin.id, field: 'text' }, false)!;
    expect(typing.value()).toBe(pc.text);
    typing.edit([{ retain: pc.text.length }, { insert: '-1' }]);
    typing.end(true);
    expect(a.device(twin.id)?.text).toBe(`${pc.text}-1`);
    await until(() => b.device(pc.id)?.text === `${pc.text}-1`, 5_000, 'the letters to reach the other board');

    a.s().undo();
    expect(a.device(twin.id)).toMatchObject({ text: pc.text, shared: b.device(pc.id)?.shared });
    await until(() => b.device(pc.id)?.text === pc.text, 5_000, 'the undo to reach the other board');
  });

  it('undoes a link made here, leaving the shared device to a device someone else linked to it meanwhile', async () => {
    const { a, b, pc, twin, back, key } = await onTwoBoards();
    const third = b.add('pc', 600, 0);
    b.s().linkTo(third.id, b.entry(back, twin.id));
    expect(b.device(third.id)?.shared).toBe(key);
    await until(() => a.device(third.id, seed.board.id)?.shared === key, 5_000, "the other editor's link to arrive");

    a.s().undo();
    expect(a.device(twin.id)?.shared).toBeUndefined();
    for (const x of [a, b]) {
      await until(() => !!x.device(pc.id, seed.board.id) && !x.device(pc.id, seed.board.id)?.shared, 5_000, 'the undo to reach each editor');
      expect(x.device(pc.id, seed.board.id)?.text).toBe(pc.text);
      expect(x.device(third.id, seed.board.id)).toMatchObject({ shared: key, text: pc.text });
    }
  });

  it('keeps the host name and IP software placed on two software boards showed, once it runs on no device', async () => {
    const a = await editor();
    const pc = a.add('pc', 300, 0);
    a.s().updateNode(pc.id, { ip: '192.168.0.10' });
    const soft = a.addBoard('ソフト', 'software');
    const td = a.add('td');
    a.addBoard('ソフト2', 'software');
    const td2 = a.add('td');
    a.s().linkTo(td2.id, a.entry(soft, td.id));
    a.s().runOn(td2.id, a.entry(seed.board.id, pc.id));
    expect(a.device(td2.id)).toMatchObject({ host: pc.text, ip: '192.168.0.10' });

    a.s().runOn(td2.id, null);
    expect(a.device(td2.id)?.runsOn).toBeUndefined();
    expect(a.device(td2.id)).toMatchObject({ host: pc.text, ip: '192.168.0.10' });
    expect(a.device(td.id, soft)).toMatchObject({ host: pc.text, ip: '192.168.0.10' });
  });
});
