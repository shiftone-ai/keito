import { rmSync } from 'node:fs';
import { type Browser, type Locator, type Page, expect, test } from '@playwright/test';
import { type RunningServer, seedData, startServer } from '../test/collab';

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

/** A browser of its own (no storage shared with the others) following the project's join link. */
async function openLink(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token })}`);
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  return page;
}

type Pt = { x: number; y: number };
/** The middle of what a locator finds, on the page. */
async function middleOf(what: Locator): Promise<Pt> {
  const at = (await what.boundingBox())!;
  return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
}
/** Click the middle of what a locator finds, as a person would: the text drawn on the board takes no clicks of its own. */
async function clickOn(page: Page, what: Locator): Promise<void> {
  const at = await middleOf(what);
  await page.mouse.click(at.x, at.y);
}
/** Press at `from` and let go at `to`, moving in steps; `between` runs halfway, the button still held. */
async function drag(page: Page, from: Pt, to: Pt, between: () => Promise<void> = async () => {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await between();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}
/** Wait until both browsers have stored their edits and `read` gives the same on both; returns it. */
async function alike<T>(a: Page, b: Page, read: (page: Page) => Promise<T>): Promise<T> {
  for (const page of [a, b]) await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect.poll(async () => JSON.stringify(await read(a)) === JSON.stringify(await read(b))).toBe(true);
  return read(a);
}

const shape = (page: Page) => page.locator('#canvas rect[width="160"][height="80"]:not([fill="none"])');
/** The shape and the boxes as drawn, back to front, each by where it is and how wide. */
const drawn = (page: Page) =>
  page.locator('#canvas rect[width="160"][height="80"]:not([fill="none"]), #canvas rect[width="140"][height="60"]:not([fill="none"])').evaluateAll((rects) => rects.map((r) => ['x', 'y', 'width'].map((k) => r.getAttribute(k)).join(',')));
/** How wide what is picked is, by the outline drawn round it: 160 the shape, 140 a box. */
const picked = (page: Page) => page.locator('#canvas rect[fill="none"][rx="3"][pointer-events="none"]').getAttribute('width');

test('two browsers draw a shape and boxes in one order and pick the same at a point when one brings the shape to the front while the other puts a box there, and undo sends it back', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  const putBox = async (page: Page, at: Pt) => {
    await page.locator('.toolbar button[aria-label="四角"]').click();
    await page.mouse.click(at.x, at.y);
  };
  // A box over the middle of the shape, drawn above it.
  const middle = await middleOf(shape(a));
  await putBox(a, middle);
  const [, box] = await alike(a, b, drawn);
  expect(box).toMatch(/,140$/);

  // At once: one brings the shape to the front from the menu on its edge, which the box leaves
  // free; the other puts a box a little lower.
  const edge = (await shape(a).boundingBox())!;
  await a.mouse.click(edge.x + edge.width / 40, edge.y + edge.height / 2, { button: 'right' });
  await b.locator('.toolbar button[aria-label="四角"]').click();
  await a.locator('.context-menu button', { hasText: '最前面へ' }).click();
  await b.mouse.click(middle.x, middle.y + 20);
  const order = await alike(a, b, drawn);
  expect(order).toHaveLength(3);
  expect(order.findIndex((x) => x.endsWith(',160'))).toBeGreaterThan(order.indexOf(box));
  // Clicked at the middle, both pick what is drawn on top there.
  for (const page of [a, b]) {
    await page.keyboard.press('Escape');
    await page.mouse.click(middle.x, middle.y);
  }
  expect(await picked(b)).toBe(await picked(a));

  // Undone, the shape goes back beneath the box on both.
  await a.keyboard.press('ControlOrMeta+z');
  const undone = await alike(a, b, drawn);
  expect(undone.findIndex((x) => x.endsWith(',160'))).toBeLessThan(undone.indexOf(box));

  const c = await openLink(browser);
  expect(await drawn(c)).toEqual(undone);
});

/** A device the board shows, by its name. */
const device = (page: Page, name: string) => page.locator('#canvas').getByText(name, { exact: true });
/** Put a device from the library on the board, (dx, dy) from the middle of the canvas. */
async function putDevice(page: Page, name: string, dx: number, dy: number): Promise<void> {
  await page.locator('.library-top input').fill(name);
  const item = (await page.locator('.library .item', { has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) }).boundingBox())!;
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(item.x + 20, item.y + item.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + dx, area.y + area.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
}
/** The names of the ports of the device picked, as the inspector lists them (inputs, then outputs). */
const portRows = (page: Page) => page.locator('.inspector .port-row input').evaluateAll((inputs) => inputs.map((x) => (x as HTMLInputElement).value));
/** How far down the board a port's name is drawn. */
const portY = async (page: Page, name: string) => (await page.locator('#canvas').getByText(name, { exact: true }).boundingBox())!.y;
/** The cable list as the lists panel shows it, once it lists `count` lines; the panel is closed again. */
async function cables(page: Page, count: number): Promise<string[]> {
  const panel = page.locator('.topbar-end button', { hasText: '機材・ケーブル表' });
  await panel.click();
  const tab = page.locator('.lists .tabs button', { hasText: 'ケーブルリスト' });
  await tab.click();
  await expect(tab.locator('small')).toHaveText(String(count));
  const rows = await page.locator('.lists table tr').allInnerTexts();
  await panel.click();
  return rows;
}

test('two browsers keep a line on a port one moves down while the other pulls the line from it, the ports in one order on the board, in the inspector and in the cable list', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await a.getByRole('button', { name: '機材ライブラリ' }).click();
  await putDevice(a, 'PC', -250, 120);
  await putDevice(a, 'プロジェクター', 250, 120);
  await expect(device(b, 'プロジェクター')).toHaveCount(1);
  await a.getByRole('button', { name: '機材ライブラリ' }).click();
  await clickOn(a, device(a, 'PC'));
  expect(await portRows(a)).toEqual(['LAN', 'USB', 'AC', 'HDMI 1', 'HDMI 2', 'DP']);

  // The PC's outputs come after its inputs (LAN, USB, AC): HDMI 1 is the fourth.
  const hdmi1 = b.locator('#canvas circle.port-hit').nth(3);
  await drag(b, await middleOf(hdmi1), await middleOf(device(b, 'プロジェクター')), async () => {
    await a.locator('.inspector .port-row').nth(3).locator('button[title="下へ"]').click();
    await expect.poll(() => portY(b, 'HDMI 1')).toBeGreaterThan(await portY(b, 'HDMI 2'));
  });

  const listed = await alike(a, b, (page) => cables(page, 1));
  expect(listed.join('\n')).toMatch(/PC\tHDMI 1\tプロジェクター\tHDMI/);
  await clickOn(b, device(b, 'PC'));
  expect(await alike(a, b, portRows)).toEqual(['LAN', 'USB', 'AC', 'HDMI 2', 'HDMI 1', 'DP']);
  // The line leaves the PC where HDMI 1 is drawn now, alike on both.
  const line = (page: Page) => page.locator('#canvas path[stroke="transparent"]').getAttribute('d');
  expect(await line(b)).toBe(await line(a));
  const start = Number(/^M\s*[-\d.]+[ ,]([-\d.]+)/.exec((await line(a))!)?.[1]);
  expect(start).toBe(Number(await a.locator('#canvas circle.port-hit').nth(4).getAttribute('cy')));
});

/** The rows of the equipment list as the lists panel shows them. */
const equipment = (page: Page) => page.locator('.lists tbody tr').allInnerTexts();
/** Drag a row of the list on show by its grip to where the row `to` is. */
async function dragRow(page: Page, from: number, to: number): Promise<void> {
  const rows = page.locator('.lists tbody tr');
  await drag(page, await middleOf(rows.nth(from).locator('td.grip')), await middleOf(rows.nth(to).locator('td.grip')));
}

test('two browsers list the equipment in the order either drags its rows to, and in the list\'s own order once one puts it back, until undone', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await a.getByRole('button', { name: '機材ライブラリ' }).click();
  await putDevice(a, 'PC', -250, 0);
  await putDevice(a, 'プロジェクター', 250, 0);
  await putDevice(a, 'LEDウォール', 0, 200);
  await expect(device(b, 'LEDウォール')).toHaveCount(1);
  for (const page of [a, b]) {
    await page.locator('.topbar-end button', { hasText: '機材・ケーブル表' }).click();
    await page.locator('.lists .tabs button', { hasText: '機材リスト' }).click();
  }
  const own = await alike(a, b, equipment);
  // After the grip, No, 区分 and カテゴリ.
  const names = (rows: string[]) => rows.map((row) => row.split('\t')[4]);
  expect(names(own)).toHaveLength(4);

  /** `rows` with the row `from` taken out and put back at `to`. */
  const moved = (rows: string[], from: number, to: number) => {
    const out = [...rows];
    out.splice(to, 0, ...out.splice(from, 1));
    return out;
  };
  await dragRow(a, 0, 2);
  const once = await alike(a, b, equipment);
  expect(names(once)).toEqual(names(moved(own, 0, 2)));
  await dragRow(b, 1, 0);
  const byHand = await alike(a, b, equipment);
  expect(names(byHand)).toEqual(names(moved(once, 1, 0)));

  await a.locator('.lists .list-tool', { hasText: '並びを元に戻す' }).click();
  expect(await alike(a, b, equipment)).toEqual(own);
  await a.keyboard.press('ControlOrMeta+z');
  expect(await alike(a, b, equipment)).toEqual(byHand);

  const c = await openLink(browser);
  await c.locator('.topbar-end button', { hasText: '機材・ケーブル表' }).click();
  await c.locator('.lists .tabs button', { hasText: '機材リスト' }).click();
  expect(await equipment(c)).toEqual(byHand);
});
