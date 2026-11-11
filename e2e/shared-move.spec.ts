import { rmSync } from 'node:fs';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { type RunningServer, seedData, startServer } from '../test/collab';

let data: string;
let server: RunningServer;
let project: string;
let token: string;

test.beforeEach(async () => {
  const seeded = seedData();
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

test('two browsers share a moved shape, and it is there after the server is killed', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  // The token is kept by the browser, not left in the address.
  expect(a.url()).not.toContain(token);
  await expect(a.locator('.board-switch')).toHaveText(/共有テスト（共有中）/);
  expect(await placeOf(b)).toEqual({ x: 0, y: 0 });

  const box = (await a.locator('#canvas text', { hasText: '図形' }).first().boundingBox())!;
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.mouse.down();
  await a.mouse.move(box.x + 120, box.y + 80, { steps: 8 });
  await a.mouse.move(box.x + 220, box.y + 140, { steps: 8 });
  await a.mouse.up();

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

test('a shared board takes only moves, and a board of this machine still saves to its folder', async ({ browser }) => {
  const a = await openLink(browser);
  await expect(a.locator('.toolbar button[aria-label="四角"]')).toHaveCount(0);
  await shape(a).click();
  await expect(a.locator('.inspector fieldset :is(input, textarea, select)').first()).toBeDisabled();
  await a.keyboard.press('Delete');
  await expect(a.locator('.notice')).toHaveText(/共有中のボードでは/);
  await expect(shape(a)).toHaveCount(1);
  await shape(a).click({ button: 'right' });
  await expect(a.locator('.context-menu button', { hasText: 'コピー' })).toBeEnabled();
  for (const label of ['切り取り', '貼り付け', '複製', '削除']) await expect(a.locator('.context-menu button', { hasText: label })).toBeDisabled();
  await a.keyboard.press('Escape');

  // Leaving for a board of this machine closes the shared project there.
  await a.locator('.board-switch').click();
  await a.locator('.project-menu button.project-item:not(.all)').first().click();
  await expect(a.locator('.board-switch')).not.toHaveText(/共有中/);
  await expect(a.locator('.save-state')).toHaveText('フォルダに保存済み');
});
