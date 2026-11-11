import { rmSync } from 'node:fs';
import { type Browser, type Page, expect, test } from '@playwright/test';
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

/** A browser of its own following the project's join link; it says yes to what it is asked. */
async function openLink(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => void (d.type() === 'confirm' ? d.accept() : d.dismiss()));
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token })}`);
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  return page;
}

const tabs = (page: Page) => page.locator('.board-tabs .board-tab:not(.add)');
const tab = (page: Page, title: string) => tabs(page).filter({ hasText: title });
const card = (page: Page, title: string) => page.locator('.modal.boards .board-card').filter({ hasText: title });

async function openBoardsWindow(page: Page): Promise<void> {
  await page.locator('.board-switch').click();
  await page.locator('.project-item.all').click();
}

test("two browsers add, rename, delete and restore a shared project's boards", async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await expect(tabs(a)).toHaveText(['配置']);

  // Added from the ＋ beside the tabs: opened here, a tab for the other browser.
  await a.locator('.board-tab.add').click();
  await a.locator('.new-board .kind-card', { hasText: '自由ボード' }).click();
  await a.locator('.new-board input').fill('照明');
  await a.locator('.new-board button', { hasText: '追加する' }).click();
  await expect(tab(a, '照明')).toHaveClass(/\bon\b/);
  await expect(tabs(b)).toHaveText(['配置', '照明']);

  await openBoardsWindow(a);
  await card(a, '照明').getByRole('button', { name: '名前を変える' }).click();
  const name = a.locator('.modal.boards .board-card input');
  await name.fill('照明（客席）');
  await name.press('Enter');
  await a.locator('.modal.boards header button').click();
  await expect(tabs(b)).toHaveText(['配置', '照明（客席）']);

  // Deleted while the other browser shows it: that one moves to the board beside it.
  await tab(b, '照明（客席）').click();
  await expect(tab(b, '照明（客席）')).toHaveClass(/\bon\b/);
  await a.locator('.topbar button', { hasText: 'ボードを削除' }).click();
  await expect(tabs(a)).toHaveText(['配置']);
  await expect(tabs(b)).toHaveText(['配置']);
  await expect(tab(b, '配置')).toHaveClass(/\bon\b/);
  await expect(b.locator('.notice')).toContainText('「照明（客席）」が削除されたため');

  await openBoardsWindow(b);
  await card(b, '照明（客席）').getByRole('button', { name: '戻す' }).click();
  await expect(tab(b, '照明（客席）')).toHaveClass(/\bon\b/);
  await expect(tabs(a)).toHaveText(['配置', '照明（客席）']);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
});

test('a shared project whose last board is deleted shows a board to add, and opens it', async ({ browser }) => {
  const a = await openLink(browser);
  await a.locator('.topbar button', { hasText: 'ボードを削除' }).click();
  await expect(tabs(a)).toHaveCount(0);
  await expect(a.locator('.empty-project .board-card', { hasText: '配置' })).toBeVisible();

  await a.locator('.empty-project button', { hasText: 'ボードを追加' }).click();
  await a.locator('.new-board input').fill('配線');
  await a.locator('.new-board input').press('Enter');
  await expect(tabs(a)).toHaveText(['配線']);
  await expect(a.locator('.empty-project')).toHaveCount(0);
});
