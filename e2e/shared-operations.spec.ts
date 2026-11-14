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
/** The project's shape and its copies, in the order they are drawn (not the outline drawn round one selected). */
const SHAPES = '#canvas rect[width="160"][height="80"]:not([fill="none"])';
/** Boxes put with the toolbar, and their copies. */
const BOXES = '#canvas rect[width="140"][height="60"]:not([fill="none"])';
/** Where each of them is on the board (its own coordinates, not the screen's). */
const shapes = (page: Page) => page.locator(SHAPES);
const boxes = (page: Page) => page.locator(BOXES);
const placesOf = (page: Page, which: string): Promise<Pt[]> =>
  page.locator(which).evaluateAll((all) => all.map((el) => ({ x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')) })));
const tab = (page: Page, title: string) => page.locator('.board-tabs .board-tab:not(.add)').filter({ hasText: title });

async function middleOf(what: Locator): Promise<Pt> {
  const at = (await what.boundingBox())!;
  return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
}
/** Click the middle of what a locator finds, as a person would: the text drawn on the board takes no clicks of its own. */
async function clickOn(page: Page, what: Locator, button: 'left' | 'right' = 'left'): Promise<void> {
  const at = await middleOf(what);
  await page.mouse.click(at.x, at.y, { button });
}
/** Press on `what` and let go (dx, dy) away, moving in steps; `between` runs halfway, the button still held. */
async function drag(page: Page, what: Locator, dx: number, dy: number, between: () => Promise<void> = async () => {}): Promise<void> {
  const from = await middleOf(what);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await between();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}
/**
 * Click the empty corner of the board, letting go of the selection: a press on what was just pressed
 * would be taken for a double-click, to type into it.
 */
async function clickAway(page: Page): Promise<void> {
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(area.x + area.width - 40, area.y + 40);
}
/** Put a box with the toolbar, (dx, dy) from the middle of the board. */
async function putBox(page: Page, dx: number, dy: number): Promise<void> {
  await page.locator('.toolbar button[aria-label="四角"]').click();
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(area.x + area.width / 2 + dx, area.y + area.height / 2 + dy);
}
/** Add a free board from the ＋ beside the tabs: it is opened. */
async function addBoard(page: Page, title: string): Promise<void> {
  await page.locator('.board-tab.add').click();
  await page.locator('.new-board .kind-card', { hasText: '自由ボード' }).click();
  const name = page.locator('.new-board input[placeholder^="ボードの名前"]');
  await name.fill(title);
  await name.press('Enter');
  await expect(tab(page, title)).toHaveClass(/\bon\b/);
}

test('two browsers share copies and an alignment made at once with other edits, and each undo takes back one of them', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);

  // At once: one duplicates the shape, the other puts a box and pastes a copy of it from the menu.
  await clickOn(a, shapes(a).first());
  await a.keyboard.press('ControlOrMeta+d');
  await putBox(b, 200, 160);
  // Put down, the box opens its text to type into, as on a board of this machine.
  await b.keyboard.press('Escape');
  await clickOn(b, boxes(b).first(), 'right');
  await b.locator('.context-menu button', { hasText: 'コピー' }).click();
  await clickOn(b, boxes(b).first(), 'right');
  await b.locator('.context-menu button', { hasText: '貼り付け' }).click();
  for (const page of [a, b]) {
    await expect(shapes(page)).toHaveCount(2);
    await expect(boxes(page)).toHaveCount(2);
  }
  expect(await placesOf(b, SHAPES)).toEqual([{ x: 0, y: 0 }, { x: 30, y: 30 }]);

  // One aligns the shape and its copy on the left, the other colours the copy. The shape is taken
  // with Shift by its lower left corner, clear of the copy and of the bar over it (and after a click
  // on the copy: a second click on the shape would be a double-click, to type into it).
  await clickOn(a, shapes(a).nth(1));
  const shape = (await shapes(a).first().boundingBox())!;
  await a.keyboard.down('Shift');
  await a.mouse.click(shape.x + 8, shape.y + shape.height - 8);
  await a.keyboard.up('Shift');
  await a.locator('.inspector button', { hasText: '左揃え' }).click();
  await clickOn(b, shapes(b).nth(1));
  await b.locator('.inspector .swatches button[title="blue"]').click();
  await expect.poll(() => placesOf(b, SHAPES)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 30 }]);
  const blue = (await shapes(b).nth(1).getAttribute('fill'))!;
  expect(blue).not.toBe(await shapes(b).first().getAttribute('fill'));
  await expect(shapes(a).nth(1)).toHaveAttribute('fill', blue);

  // One undo each: the alignment, then the copy. The other browser's colour, box and paste stay.
  await a.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => placesOf(b, SHAPES)).toEqual([{ x: 0, y: 0 }, { x: 30, y: 30 }]);
  await expect(shapes(b).nth(1)).toHaveAttribute('fill', blue);
  await a.keyboard.press('ControlOrMeta+z');
  await expect(shapes(b)).toHaveCount(1);
  await expect(boxes(b)).toHaveCount(2);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await a.reload();
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(shapes(a)).toHaveCount(1);
  expect(await placesOf(a, BOXES)).toEqual(await placesOf(b, BOXES));
});

test("Escape calls a drag off on a shared board, keeping what the other browser did meanwhile; one undo takes back an Alt-drag, and after switching boards that board's own edit", async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  const white = (await shapes(a).first().getAttribute('fill'))!;

  // Called off while the other browser colours the shape being dragged.
  await drag(a, shapes(a).first(), 220, 140, async () => {
    await clickOn(b, shapes(b).first());
    await b.locator('.inspector .swatches button[title="green"]').click();
    await expect(shapes(a).first()).not.toHaveAttribute('fill', white);
    await a.keyboard.press('Escape');
  });
  for (const page of [a, b]) expect(await placesOf(page, SHAPES)).toEqual([{ x: 0, y: 0 }]);
  await expect(shapes(a).first()).toHaveAttribute('fill', (await shapes(b).first().getAttribute('fill'))!);
  // An Alt-drag called off leaves no copy.
  await clickAway(a);
  await a.keyboard.down('Alt');
  await drag(a, shapes(a).first(), 220, 140, async () => {
    await expect(shapes(a)).toHaveCount(2);
    await a.keyboard.press('Escape');
  });
  await a.keyboard.up('Alt');
  await expect(shapes(a)).toHaveCount(1);
  expect(await placesOf(a, SHAPES)).toEqual([{ x: 0, y: 0 }]);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(shapes(b)).toHaveCount(1);
  // One let go: the copy and its move are one step to undo.
  await clickAway(a);
  await a.keyboard.down('Alt');
  await drag(a, shapes(a).first(), 220, 140);
  await a.keyboard.up('Alt');
  await expect(shapes(b)).toHaveCount(2);
  await a.keyboard.press('ControlOrMeta+z');
  await expect(shapes(b)).toHaveCount(1);
  expect(await placesOf(b, SHAPES)).toEqual([{ x: 0, y: 0 }]);

  // A box put on another board, the shape moved on this one: undo takes back each board's own.
  await addBoard(a, '照明');
  await putBox(a, 0, 0);
  await expect(boxes(a)).toHaveCount(1);
  await tab(a, '配置').click();
  await clickAway(a);
  await drag(a, shapes(a).first(), 120, 80);
  const moved = (await placesOf(a, SHAPES))[0];
  expect(moved).not.toEqual({ x: 0, y: 0 });
  await tab(a, '照明').click();
  await a.keyboard.press('ControlOrMeta+z');
  await expect(boxes(a)).toHaveCount(0);
  await tab(a, '配置').click();
  expect(await placesOf(a, SHAPES)).toEqual([moved]);
  await a.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => placesOf(b, SHAPES)).toEqual([{ x: 0, y: 0 }]);
});

test('a board of this machine takes the same: one undo for a copy and for an alignment, Escape calling a drag off, kept through a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み');
  await addBoard(page, '複製の確認');
  await putBox(page, 0, 0);
  await page.keyboard.press('Escape');
  await clickOn(page, boxes(page).first());
  await page.keyboard.press('ControlOrMeta+d');
  await expect(boxes(page)).toHaveCount(2);
  const copied = await placesOf(page, BOXES);

  await drag(page, boxes(page).nth(1), 200, 120, () => page.keyboard.press('Escape'));
  expect(await placesOf(page, BOXES)).toEqual(copied);
  await clickAway(page);
  await page.keyboard.down('Alt');
  await drag(page, boxes(page).nth(1), 200, 120, async () => {
    await expect(boxes(page)).toHaveCount(3);
    await page.keyboard.press('Escape');
  });
  await page.keyboard.up('Alt');
  expect(await placesOf(page, BOXES)).toEqual(copied);

  await page.keyboard.press('ControlOrMeta+a');
  await page.locator('.inspector button', { hasText: '左揃え' }).click();
  await expect.poll(() => placesOf(page, BOXES)).toEqual([copied[0], { x: copied[0].x, y: copied[1].y }]);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await placesOf(page, BOXES)).toEqual(copied);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(boxes(page)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => placesOf(page, BOXES)).toEqual([copied[0], { x: copied[0].x, y: copied[1].y }]);
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み');
  await page.reload();
  await expect(tab(page, '複製の確認')).toHaveClass(/\bon\b/);
  expect(await placesOf(page, BOXES)).toEqual([copied[0], { x: copied[0].x, y: copied[1].y }]);
});
