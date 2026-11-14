import { rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { type RunningServer, administer, seedData, startServer } from '../test/collab';

let data: string;
let server: RunningServer;
let project: string;

test.beforeEach(async () => {
  const seeded = seedData('system');
  data = seeded.data;
  project = seeded.seed.id;
  server = await startServer(data);
});

test.afterEach(async () => {
  await server.kill();
  rmSync(data, { recursive: true, force: true });
});

test('a join link pasted from the project menu opens the shared project as its invite lets one, the credential off the address', async ({ page }) => {
  const viewer = administer(data, (store) => store.addGrant(project, 'viewer'));
  const link = `http://localhost:5183/#/s/${project}?${new URLSearchParams({ server: server.url, token: viewer.token })}`;
  await page.goto('/');
  await page.locator('.board-switch').click();
  await page.getByRole('menuitem', { name: '共有案件に参加…' }).click();
  const field = page.getByLabel('参加リンク');
  await field.fill('http://localhost:5183/#/b/board-1');
  await field.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('参加リンクではありません');

  await field.fill(link);
  await page.getByRole('button', { name: '参加', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.board-switch')).toHaveText(/（共有中）/);
  await expect(page.locator('.save-state')).toHaveText('閲覧のみ');
  expect(new URL(page.url()).hash).toBe(`#/s/${project}`);
});
