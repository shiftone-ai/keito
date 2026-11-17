import { rmSync } from 'node:fs';
import { type Browser, type Page, expect, test } from '@playwright/test';
import type { Role } from '../src/collab/protocol';
import { type RunningServer, administer, seedData, startServer } from '../test/collab';

let data: string;
let server: RunningServer;
let project: string;
/** The editor's invite of seedData. */
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


/** A browser of its own following the join link of an invite; what its dialogs say goes to `told`, and it says yes to what it is asked. */
async function openLink(browser: Browser, credential: string, told: string[] = []): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => {
    told.push(d.message());
    void (d.type() === 'confirm' ? d.accept() : d.dismiss());
  });
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token: credential })}`);
  await expect(page.locator('.board-switch')).toHaveText(/（共有中）/);
  return page;
}

const shape = (page: Page) => page.locator('#canvas rect[width="160"][height="80"]').first();
/** Where the shape is on the board (its own coordinates, not the screen's). */
const placeOf = async (page: Page) => ({ x: Number(await shape(page).getAttribute('x')), y: Number(await shape(page).getAttribute('y')) });

/** Drag the shape by its middle by (dx, dy), as a person would. */
async function dragShape(page: Page, dx: number, dy: number): Promise<void> {
  const at = (await shape(page).boundingBox())!;
  const from = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

const invite = (role: Role) => administer(data, (store) => store.addGrant(project, role));

test("a viewer sees an editor's move as it is made, cannot move the shape itself, and is let go once its invite is revoked", async ({ browser }) => {
  const viewer = invite('viewer');
  const a = await openLink(browser, token);
  const told: string[] = [];
  const v = await openLink(browser, viewer.token, told);
  await expect(v.locator('.save-state')).toHaveText('閲覧のみ');
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(v.locator('.toolbar button[aria-label="四角"]')).toHaveCount(0);
  // Nothing to put on the board is offered either (the editor's toolbar has both).
  const placing = '.toolbar button[aria-label="凡例を置く"], .toolbar button[aria-label$="ライブラリ"]';
  await expect(a.locator(placing)).toHaveCount(2);
  await expect(v.locator(placing)).toHaveCount(0);

  await dragShape(a, 220, 140);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  const moved = await placeOf(a);
  expect(moved).not.toEqual({ x: 0, y: 0 });
  await expect.poll(() => placeOf(v)).toEqual(moved);

  await dragShape(v, -200, -100);
  expect(await placeOf(v)).toEqual(moved);
  // Selected by the press, the shape is shown, not offered to edit.
  await expect(v.locator('.inspector fieldset:disabled')).toHaveCount(1);
  await expect(v.locator('.inspector')).toContainText('閲覧のみの招待では編集できません');
  await expect(v.locator('.quickbar')).toHaveCount(0);
  await shape(v).click({ button: 'right' });
  for (const label of ['切り取り', '削除']) await expect(v.locator('.context-menu button', { hasText: label })).toBeDisabled();
  await v.keyboard.press('Escape');

  administer(data, (store) => store.revokeGrant(viewer.id));
  await expect.poll(() => told.join('\n')).toMatch(/招待は取り消されました/);
  await expect(v.locator('.board-switch')).not.toHaveText(/（共有中）/);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  expect(await placeOf(a)).toEqual(moved);

  // Opened again by its address (the invite kept in the browser): turned away.
  told.length = 0;
  await v.goto(`/#/s/${project}`);
  await expect.poll(() => told.join('\n')).toMatch(/招待は取り消されました/);
  await expect(v.locator('.board-switch')).not.toHaveText(/（共有中）/);
});

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

const listsButton = (page: Page) => page.locator('.topbar-end button', { hasText: '機材・ケーブル表' });
const rows = (page: Page) => page.locator('.lists tbody tr');
/** The rows of the list on show, each as its cells read. */
const listed = async (page: Page) => (await rows(page).allInnerTexts()).map((row) => row.trim());
/** What the list on show offers to change: cells to fill, rows to drag by, the order to put back. */
const listEdits = (page: Page) => page.locator('.lists td.editable, .lists .grip, .lists td.handle, .lists .list-tool');
/** The input a cell of the list opens to be filled. */
const CELL_INPUT = '.lists td input, .lists td select';
/** The cell of the first row under a heading of the list on show. */
const cellUnder = async (page: Page, heading: string) => rows(page).first().locator('td').nth((await page.locator('.lists thead th').allInnerTexts()).indexOf(heading));

test('a viewer reads the equipment list and picks a device by its row, and is offered no cell to fill, no row to drag and no order to put back', async ({ browser }) => {
  const a = await openLink(browser, token);
  await a.keyboard.press('l');
  await putDevice(a, 'PC', -250, 120);
  await putDevice(a, 'プロジェクター', 250, 120);
  await a.getByRole('button', { name: '機材ライブラリ' }).click();
  await listsButton(a).click();
  // The second row dragged above the first: an order made by hand, which the editor can put back.
  const grips = a.locator('.lists tbody td.grip');
  const [from, to] = [(await grips.nth(1).boundingBox())!, (await grips.nth(0).boundingBox())!];
  await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await a.mouse.up();
  await expect(a.locator('.lists .list-tool', { hasText: '並びを元に戻す' })).toBeVisible();
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await (await cellUnder(a, '数量')).click();
  await expect(a.locator(CELL_INPUT)).toHaveCount(1);
  await a.keyboard.press('Escape');

  const v = await openLink(browser, invite('viewer').token);
  await listsButton(v).click();
  await expect.poll(() => listed(v)).toEqual(await listed(a));
  await expect(listEdits(v)).toHaveCount(0);

  await (await cellUnder(v, '数量')).click();
  await expect(rows(v).first()).toHaveClass(/\bon\b/);
  await expect(v.locator(CELL_INPUT)).toHaveCount(0);
});

const tabs = (page: Page) => page.locator('.board-tabs .board-tab:not(.add)');
/** What the boards window offers to do with the shared project's boards, besides opening one. */
const boardEdits = (page: Page) => page.locator('.modal.boards .col:not(.side) button').filter({ hasText: /名前を変える|戻す|新しいボード/ });

/** The top bar's button for a new board. */
const newBoard = (page: Page) => page.locator('.topbar button', { hasText: '新しいボード' });

async function openBoardsWindow(page: Page): Promise<void> {
  await page.locator('.board-switch').click();
  await page.locator('.project-item.all').click();
}

test('a viewer is shown the boards of the project, and is offered none to add, rename or bring back, even once the project has no board', async ({ browser }) => {
  const a = await openLink(browser, token);
  // A second board, deleted again: one the editor can bring back.
  await a.locator('.board-tab.add').click();
  await a.locator('.new-board input').fill('照明');
  await a.locator('.new-board input').press('Enter');
  await expect(tabs(a).filter({ hasText: '照明' })).toHaveClass(/\bon\b/);
  await a.locator('.topbar button', { hasText: 'ボードを削除' }).click();
  await expect(tabs(a)).toHaveText(['配置']);

  const v = await openLink(browser, invite('viewer').token);
  await expect(tabs(v)).toHaveText(['配置']);
  await expect(v.locator('.board-tab.add')).toHaveCount(0);
  await expect(newBoard(a)).toBeEnabled();
  await expect(newBoard(v)).toBeDisabled();
  await newBoard(v).hover();
  await expect(v.locator('.tip.on')).toHaveText('閲覧のみの招待では編集できません');

  for (const page of [a, v]) await openBoardsWindow(page);
  await expect(boardEdits(a)).toHaveCount(4);
  await expect(v.locator('.modal.boards .board-card.shared')).toHaveText(/配置/);
  await expect(boardEdits(v)).toHaveCount(0);
  for (const page of [a, v]) await page.locator('.modal.boards header button').click();

  await a.locator('.topbar button', { hasText: 'ボードを削除' }).click();
  await expect(a.locator('.empty-project button', { hasText: 'ボードを追加' })).toBeVisible();
  await expect(tabs(v)).toHaveCount(0);
  await expect(v.locator('.empty-project button')).toHaveCount(0);
});

test("a viewer's L key opens no library out of sight: the next Escape closes the lists", async ({ browser }) => {
  const v = await openLink(browser, invite('viewer').token);
  await listsButton(v).click();
  await expect(v.locator('.lists')).toBeVisible();
  await v.keyboard.press('l');
  await v.keyboard.press('Escape');
  await expect(v.locator('.lists')).toHaveCount(0);
});
