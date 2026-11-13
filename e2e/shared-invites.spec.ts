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


/** A browser of its own following the join link of an invite; what its dialogs say goes to `told`. */
async function openLink(browser: Browser, credential: string, told: string[] = []): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => {
    told.push(d.message());
    void d.dismiss();
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
