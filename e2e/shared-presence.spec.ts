import { rmSync } from 'node:fs';
import { type Browser, type Locator, type Page, expect, test } from '@playwright/test';
import * as Y from 'yjs';
import { type RunningServer, type Relay, administer, seedData, startRelay, startServer, storedEdits } from '../test/collab';

let data: string;
let server: RunningServer;
let project: string;
let token: string;

test.beforeEach(async () => {
  const seeded = seedData('system');
  ({ data, token } = seeded);
  project = seeded.seed.id;
  server = await startServer(data);
});

test.afterEach(async () => {
  await server.kill();
  rmSync(data, { recursive: true, force: true });
});

/** A join link of the project (by way of `via`, the server's unless given). */
const linkOf = (via = server.url, to = project, credential = token) => `/#/s/${to}?${new URLSearchParams({ server: via, token: credential })}`;

/** A browser of its own (no storage shared with the others) following the project's join link; `first` is done before. */
async function openLink(browser: Browser, via?: string, first: (page: Page) => void = () => {}): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => void d.dismiss());
  first(page);
  await page.goto(linkOf(via));
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  return page;
}

type Pt = { x: number; y: number };
/** The project's shape (not the outline drawn round it selected). */
const SHAPES = '#canvas rect[width="160"][height="80"]:not([fill="none"])';
const shapes = (page: Page) => page.locator(SHAPES);
const placesOf = (page: Page): Promise<Pt[]> => page.locator(SHAPES).evaluateAll((all) => all.map((el) => ({ x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')) })));
/** What another page draws of the one named `name`, and the place it is dragging something to. */
const marksOf = (page: Page, name: string) => page.locator(`#canvas [data-peer="${name}"]`);
const moving = (page: Page) => page.locator('#canvas .peer-moving');

async function middleOf(what: Locator): Promise<Pt> {
  const at = (await what.boundingBox())!;
  return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
}
/**
 * Click the empty corner of the board, letting go of the selection: a press on what was just pressed
 * would be taken for a double-click, to type into it.
 */
async function clickAway(page: Page): Promise<void> {
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(area.x + area.width - 40, area.y + 40);
}
/** Press on `what` and move (dx, dy) in steps, the button still held. */
async function hold(page: Page, what: Locator, dx: number, dy: number): Promise<void> {
  const from = await middleOf(what);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
}
/** Show this page's user to the others as `name`. */
async function introduce(page: Page, name: string): Promise<void> {
  await page.locator('.participants .faces').click();
  const field = page.locator('.participants-menu input[aria-label="表示名"]');
  await field.fill(name);
  await field.press('Enter');
  await page.keyboard.press('Escape');
}
/** The others a page lists, with the board each is on. */
async function listed(page: Page): Promise<string[]> {
  await page.locator('.participants .faces').click();
  const rows = await page.locator('.participants-menu li').allInnerTexts();
  await page.keyboard.press('Escape');
  return rows.map((r) => r.replace(/\s+/g, ' ').trim());
}
/** What of a page is its own: how far it is zoomed and scrolled, the tool, the board and the panels open. */
const personal = (page: Page) =>
  page.evaluate(() => ({
    view: document.querySelector('#canvas svg > g')?.getAttribute('transform'),
    tool: document.querySelector('.toolbar button.on')?.getAttribute('aria-label'),
    board: document.querySelector('.board-tabs .board-tab.on')?.textContent,
    panels: [...document.querySelectorAll('.topbar-end button.on')].map((b) => b.textContent),
  }));


/**
 * Every awareness state a page sends (decoded from its WebSocket frames: the document's name, the
 * message type, then the awareness update), as JSON.
 */
function awarenessSent(page: Page): string[] {
  const sent: string[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') return;
      let frame: Buffer = payload;
      let at = 0;
      const uint = (): number => {
        let n = 0;
        for (let shift = 0; ; shift += 7) {
          const b = frame[at++];
          n += (b & 0x7f) * 2 ** shift;
          if (b < 0x80) return n;
        }
      };
      const bytes = (): Buffer => {
        const n = uint();
        return frame.subarray(at, (at += n));
      };
      bytes();
      if (uint() !== 1) return;
      [frame, at] = [bytes(), 0];
      for (let clients = uint(); clients > 0; clients--) {
        uint();
        uint();
        sent.push(bytes().toString('utf8'));
      }
    }),
  );
  return sent;
}

test('two browsers show each other who is there, where they point and what they pick, and a drag as it goes, written once where it is let go', async ({ browser }) => {
  let sent: string[] = [];
  const [a, b] = await Promise.all([openLink(browser, undefined, (page) => void (sent = awarenessSent(page))), openLink(browser)]);
  await introduce(a, 'あかね');
  await introduce(b, 'ひかり');
  await expect.poll(() => listed(b)).toEqual(['あ あかね 配置']);
  const mine = await personal(b);

  const shape = await middleOf(shapes(a).first());
  await a.mouse.move(shape.x - 100, shape.y - 80);
  await expect(marksOf(b, 'あかね').locator('.peer-pointer')).toBeVisible();
  await a.mouse.click(shape.x, shape.y);
  await expect(marksOf(b, 'あかね').locator('rect[fill="none"]')).toHaveCount(1);
  await clickAway(a);
  await expect(marksOf(b, 'あかね').locator('rect[fill="none"]')).toHaveCount(0);

  const before = storedEdits(data, project);
  await hold(a, shapes(a).first(), 150, 90);
  await expect(moving(b)).toHaveCount(1);
  expect(await placesOf(b)).toEqual([{ x: 0, y: 0 }]);
  expect(storedEdits(data, project)).toBe(before);
  await a.mouse.up();
  await expect(moving(b)).toHaveCount(0);
  await expect.poll(() => placesOf(b)).toEqual(await placesOf(a));
  expect(await placesOf(b)).not.toEqual([{ x: 0, y: 0 }]);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  expect(storedEdits(data, project)).toBe(before + 1);
  expect(await personal(b)).toEqual(mine);

  // What a sent of itself: what it shows, and nothing of its invite. Nor is any of it in the project as stored.
  const invite = administer(data, (store) => store.grantOf(token))!;
  expect(sent.some((state) => state.includes('あかね'))).toBe(true);
  for (const state of sent) {
    expect(state.includes(token) || state.includes(invite)).toBe(false);
    if (state !== 'null' && state !== '{}') expect(Object.keys(JSON.parse(state)).sort()).toEqual(['board', 'color', 'editing', 'moving', 'name', 'pointer', 'selection']);
  }
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, administer(data, (store) => store.load(project))!);
  expect(JSON.stringify(ydoc.toJSON())).not.toMatch(/あかね|ひかり|pointer/);
});

test('a drag called off, cut off with its connection, or of a node someone else deletes, leaves no mark, and the place last written', async ({ browser }) => {
  let relay: Relay | null = null;
  try {
    relay = await startRelay(server.url);
    const [a, b] = await Promise.all([openLink(browser, relay.url), openLink(browser)]);
    await introduce(a, 'あかね');
    await expect.poll(() => listed(b)).toEqual(['あ あかね 配置']);

    // Called off.
    await hold(a, shapes(a).first(), 150, 90);
    await expect(moving(b)).toHaveCount(1);
    await a.keyboard.press('Escape');
    await a.mouse.up();
    await expect(moving(b)).toHaveCount(0);
    expect(await placesOf(b)).toEqual([{ x: 0, y: 0 }]);
    await clickAway(a);

    // Deleted by the other page as it is dragged: the drag ends, and the next edit goes on.
    await hold(a, shapes(a).first(), 150, 90);
    await expect(moving(b)).toHaveCount(1);
    const target = await middleOf(shapes(b).first());
    await b.mouse.click(target.x, target.y);
    await b.keyboard.press('Delete');
    await expect(shapes(a)).toHaveCount(0);
    await a.mouse.move(400, 400, { steps: 3 });
    await a.mouse.up();
    await expect(moving(b)).toHaveCount(0);
    await expect(marksOf(b, 'あかね').locator('rect[fill="none"]')).toHaveCount(0);
    const before = storedEdits(data, project);
    await a.locator('.toolbar button[aria-label="四角"]').click();
    const area = (await a.locator('#canvas').boundingBox())!;
    await a.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
    const boxes = (page: Page) => page.locator('#canvas rect[width="140"][height="60"]:not([fill="none"])');
    await expect(boxes(b)).toHaveCount(1);
    const box = (await boxes(b).first().getAttribute('x'))!;

    // Cut off as it drags: gone from the other page, which keeps the place last written.
    await hold(a, boxes(a).first(), 150, 90);
    await expect(moving(b)).toHaveCount(1);
    relay.cut();
    await expect(marksOf(b, 'あかね')).toHaveCount(0);
    await expect.poll(() => listed(b)).toEqual([]);
    await a.mouse.up();
    await a.context().close();
    await expect(boxes(b).first()).toHaveAttribute('x', box);
    expect(storedEdits(data, project)).toBe(before + 1);
  } finally {
    await relay?.close();
  }
});

test('a page that leaves, or opens another project, is no longer shown', async ({ browser }) => {
  const [a, b, c] = await Promise.all([openLink(browser), openLink(browser), openLink(browser)]);
  await introduce(a, 'あかね');
  await introduce(c, 'みどり');
  const shape = await middleOf(shapes(a).first());
  await a.mouse.move(shape.x, shape.y);
  await c.mouse.move(shape.x, shape.y);
  await expect(marksOf(b, 'あかね').locator('.peer-pointer')).toBeVisible();
  await expect(marksOf(b, 'みどり').locator('.peer-pointer')).toBeVisible();

  // Another project, opened by its link in the same page.
  const other = administer(data, (store) => {
    const made = store.initProject({ title: '別の案件', board: '別の配置', shape: '図形' });
    return { id: made.id, token: store.addGrant(made.id).token };
  });
  await c.evaluate((hash) => void (location.hash = hash), linkOf(server.url, other.id, other.token).slice(1));
  await expect(c.locator('.board-tabs .board-tab.on')).toContainText('別の配置');
  await expect(marksOf(b, 'みどり')).toHaveCount(0);
  await expect.poll(() => listed(b)).toEqual(['あ あかね 配置']);
  await expect.poll(() => listed(c)).toEqual([]);

  // Closed.
  await a.context().close();
  await expect(marksOf(b, 'あかね')).toHaveCount(0);
  await expect.poll(() => listed(b)).toEqual([]);
});
