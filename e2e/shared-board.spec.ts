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

const shape = (page: Page) => page.locator('#canvas rect[width="160"][height="80"]').first();
/** Where the shape is on the board (its own coordinates, not the screen's). */
const placeOf = async (page: Page) => ({ x: Number(await shape(page).getAttribute('x')), y: Number(await shape(page).getAttribute('y')) });
/** A box put with the toolbar, not the outline drawn round it while it is selected. */
const box = (page: Page) => page.locator('#canvas rect[width="140"][height="60"]:not([fill="none"])');
/** The colour picked in the inspector for what is selected. */
const colour = (page: Page) => page.locator('.inspector .swatches button.on');
/** Click the middle of what a locator finds, as a person would: the text drawn on the board takes no clicks of its own. */
async function clickOn(page: Page, what: Locator): Promise<void> {
  const at = (await what.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
}
/** Drag the shape by its middle by (dx, dy), in steps; `between` runs halfway, the button still held. */
async function dragShape(page: Page, dx: number, dy: number, between: () => Promise<void> = async () => {}): Promise<void> {
  const at = (await shape(page).boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + dx / 2, at.y + at.height / 2 + dy / 2, { steps: 5 });
  await between();
  await page.mouse.move(at.x + at.width / 2 + dx, at.y + at.height / 2 + dy, { steps: 5 });
  await page.mouse.up();
}

test('two browsers share a moved shape, and it is there after the server is killed', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  // The token is kept by the browser, not left in the address.
  expect(a.url()).not.toContain(token);
  await expect(a.locator('.board-switch')).toHaveText(/共有テスト（共有中）/);
  expect(await placeOf(b)).toEqual({ x: 0, y: 0 });

  await dragShape(a, 220, 140);

  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  const moved = await placeOf(a);
  expect(moved).not.toEqual({ x: 0, y: 0 });
  await expect.poll(() => placeOf(b)).toEqual(moved);

  // Killed outright, then started again on the same port: what was confirmed is still there.
  const port = new URL(server.url).port;
  await server.kill();
  await expect(a.locator('.save-state')).toHaveText('オフライン');
  server = await startServer(data, Number(port));
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み', { timeout: 15_000 });
  const c = await openLink(browser);
  expect(await placeOf(c)).toEqual(moved);
  await a.reload();
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  expect(await placeOf(a)).toEqual(moved);
});

test('two browsers see the boxes each puts on a shared board, and the colours and sizes each gives them', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await a.locator('.toolbar button[aria-label="四角"]').click();
  const area = (await a.locator('#canvas').boundingBox())!;
  await a.mouse.click(area.x + area.width / 2 + 160, area.y + area.height / 2 + 160);
  await expect(box(b)).toHaveCount(1);

  await box(b).first().click();
  await b.locator('.inspector .swatches button[title="blue"]').click();
  await box(a).first().click();
  await expect(colour(a)).toHaveAttribute('title', 'blue');

  // Made bigger by its corner.
  const corner = (await a.locator('#canvas rect[style*="nwse-resize"]').last().boundingBox())!;
  await a.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await a.mouse.down();
  await a.mouse.move(corner.x + 60, corner.y + 40, { steps: 6 });
  await a.mouse.up();
  await expect(box(b)).toHaveCount(0);
  await expect(b.locator('.save-state')).toHaveText('共同編集先に保存済み');
});

test('what is typed into a field of a shared board reaches the other browser on Enter or on leaving the field', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  const pc = (page: Page) => page.locator('#canvas').getByText('PC', { exact: true });
  const field = (page: Page, label: string) => page.locator('.inspector label.field', { hasText: label }).locator('input');
  await a.getByRole('button', { name: '機材ライブラリ' }).click();
  await a.locator('.library-top input').fill('PC');
  const item = (await a.locator('.library .item', { has: a.locator('.label', { hasText: /^PC$/ }) }).boundingBox())!;
  const area = (await a.locator('#canvas').boundingBox())!;
  await a.mouse.move(item.x + 20, item.y + item.height / 2);
  await a.mouse.down();
  await a.mouse.move(area.x + area.width / 2 - 200, area.y + 150, { steps: 10 });
  await a.mouse.up();
  await expect(pc(b)).toHaveCount(1);

  await clickOn(a, pc(a));
  // A category typed in rather than picked from the list.
  await field(a, 'カテゴリ').fill('自作の機材');
  await field(a, 'カテゴリ').press('Enter');
  await clickOn(b, pc(b));
  await expect(field(b, 'カテゴリ')).toHaveValue('自作の機材');
  await field(a, 'IP アドレス').fill('10.0.0.5');
  await field(a, 'IP アドレス').press('Enter');
  await field(a, 'ホスト名').fill('pc-1');
  await a.mouse.click(area.x + area.width / 2 + 300, area.y + 60);
  await clickOn(b, pc(b));
  await expect(field(b, 'IP アドレス')).toHaveValue('10.0.0.5');
  await expect(field(b, 'ホスト名')).toHaveValue('pc-1');
});

test('a drag on a shared board ends without an error when the other browser takes its shape off meanwhile', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  const errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  await dragShape(b, 120, 80, async () => {
    await shape(a).click();
    await a.keyboard.press('Delete');
    await expect(shape(b)).toHaveCount(0);
  });
  await expect(b.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(shape(a)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('each browser undoes only its own edits of a shared board', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await dragShape(a, 120, 80);
  const moved = await placeOf(a);
  await expect.poll(() => placeOf(b)).toEqual(moved);
  await shape(b).click();
  await b.locator('.inspector .swatches button[title="blue"]').click();
  await shape(a).click();
  await expect(colour(a)).toHaveAttribute('title', 'blue');

  await a.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => placeOf(b)).toEqual({ x: 0, y: 0 });
  await expect(colour(b)).toHaveAttribute('title', 'blue');
  await b.keyboard.press('ControlOrMeta+z');
  await shape(a).click();
  await expect(colour(a)).toHaveAttribute('title', 'white');
  expect(await placeOf(a)).toEqual({ x: 0, y: 0 });
});

test('a shared board turns away what it does not take yet, and a board of this machine still saves to its folder', async ({ browser }) => {
  const a = await openLink(browser);
  await expect(a.locator('.toolbar button[aria-label="四角"]')).toHaveCount(1);
  for (const tool of ['テキスト', '画像・SVG を埋め込む']) await expect(a.locator(`.toolbar button[aria-label="${tool}"]`)).toHaveCount(0);
  // Text copied in another app would be pasted as a text box.
  await a.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '貼り付けたメモ');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }));
  });
  await expect(a.locator('.notice')).toHaveText(/共有中のボードでは/);
  await expect(a.locator('#canvas').getByText('貼り付けたメモ')).toHaveCount(0);
  // An Alt-drag would leave a copy behind: the shape stays where it is.
  const at = await placeOf(a);
  await a.keyboard.down('Alt');
  await dragShape(a, 120, 80);
  await a.keyboard.up('Alt');
  expect(await placeOf(a)).toEqual(at);
  await shape(a).click();
  // Its text is typed by hand: not on a shared board yet. Its look is.
  await expect(a.locator('.inspector label.field', { hasText: 'テキスト' }).locator('textarea')).toBeDisabled();
  await expect(a.locator('.inspector .swatches button').first()).toBeEnabled();
  await expect(a.locator('.quickbar button[aria-label^="削除"]')).toHaveCount(1);
  for (const tip of ['文字を編集', '複製']) await expect(a.locator(`.quickbar button[aria-label^="${tip}"]`)).toHaveCount(0);
  await shape(a).click({ button: 'right' });
  for (const label of ['コピー', '切り取り', '削除']) await expect(a.locator('.context-menu button', { hasText: label })).toBeEnabled();
  for (const label of ['貼り付け', '複製', '最前面へ', '最背面へ']) await expect(a.locator('.context-menu button', { hasText: label })).toBeDisabled();
  await a.keyboard.press('Escape');
  await a.keyboard.press('ControlOrMeta+d');
  await expect(a.locator('.notice')).toHaveText(/共有中のボードでは/);
  await expect(a.locator('#canvas rect[width="160"][height="80"]:not([fill="none"])')).toHaveCount(1);

  // Leaving for a board of this machine closes the shared project there.
  await a.locator('.board-switch').click();
  await a.locator('.project-menu button.project-item:not(.all)').first().click();
  await expect(a.locator('.board-switch')).not.toHaveText(/共有中/);
  await expect(a.locator('.save-state')).toHaveText('フォルダに保存済み');
});
