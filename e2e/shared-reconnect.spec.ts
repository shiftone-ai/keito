import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, type Page, chromium, expect, test } from '@playwright/test';
import * as Y from 'yjs';
import { boardDoc } from '../src/collab/model';
import { type RunningServer, administer, seedData, startServer } from '../test/collab';

let data: string;
let server: RunningServer;
let project: string;
let board: string;
let shapeId: string;
/** The editor's invite of seedData. */
let token: string;
/** The browser's profile folder: what it keeps (IndexedDB, localStorage) survives closing it. */
let profile: string;

test.beforeEach(async () => {
  const seeded = seedData('system');
  ({ data, token } = seeded);
  project = seeded.seed.id;
  board = seeded.seed.board.id;
  shapeId = seeded.seed.shape.id;
  server = await startServer(data);
  profile = mkdtempSync(join(tmpdir(), 'keito-e2e-profile-'));
});

test.afterEach(async () => {
  await server.kill();
  rmSync(data, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
});

/** Start the browser on its profile; what its dialogs say goes to `told`. */
async function launch(baseURL: string | undefined, told: string[]): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(profile, { baseURL, headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('dialog', (d) => {
    told.push(d.message());
    void d.dismiss();
  });
  return { context, page };
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

/** Where the server has the shape stored. */
function storedPlace() {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, administer(data, (store) => store.load(project))!);
  const n = boardDoc(ydoc, board)?.nodes.find((x) => x.id === shapeId);
  return n && { x: n.x, y: n.y };
}

test('a move made offline, then turned away as the invite was revoked, is shown with why after the browser restarts, and becomes a board of this machine', async ({ baseURL }) => {
  const told: string[] = [];
  let { context, page } = await launch(baseURL, told);
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token })}`);
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  const { port } = server;
  await server.kill();
  await expect(page.locator('.save-state')).toContainText('オフライン');
  await dragShape(page, 220, 140);
  await expect(page.locator('.save-state')).toContainText('オフライン・未送信 1 件');
  await expect(page.locator('.save-state')).toContainText('本端末に保存済み');
  const moved = await placeOf(page);
  expect(moved).not.toEqual({ x: 0, y: 0 });
  await context.close();

  administer(data, (store) => store.revokeGrant(store.grantOf(token)!));
  server = await startServer(data, port);
  ({ context, page } = await launch(baseURL, told));
  // Every text the banner and the save state show, as each is drawn.
  await page.addInitScript(() => {
    const shown: string[] = ((window as unknown as { shown: string[] }).shown = []);
    new MutationObserver(() => shown.push(['.rev-banner.refused', '.save-state'].map((at) => document.querySelector(at)?.textContent ?? '').join(' | '))).observe(document, { subtree: true, childList: true, characterData: true });
  });
  try {
    await page.goto(`/#/s/${project}`);
    const banner = page.locator('.rev-banner.refused');
    await expect(banner).toContainText('この共有案件への招待は取り消されました');
    await expect(banner).toContainText('未送信の変更 1 件は送れません');
    await expect(page.locator('.save-state')).toContainText('共同編集先に送れません');
    await expect(page.locator('.save-state')).toContainText('本端末に保存済み');
    // Kept on this device all along, they are never said to be lost, even while the refusal is being written.
    expect((await page.evaluate(() => (window as unknown as { shown: string[] }).shown)).filter((t) => t.includes('失われます'))).toEqual([]);
    expect(await placeOf(page)).toEqual(moved);
    await expect(page.locator('.toolbar button[aria-label="四角"]')).toHaveCount(0);
    expect(storedPlace()).toEqual({ x: 0, y: 0 });

    await banner.getByRole('button', { name: '手元のボードにコピー' }).click();
    await expect(page.locator('.board-switch')).toHaveText(/共有テスト のコピー/);
    await expect(page.locator('.board-switch')).not.toHaveText(/（共有中）/);
    expect(await placeOf(page)).toEqual(moved);
    expect(storedPlace()).toEqual({ x: 0, y: 0 });

    // Taken out, the move is no longer the project's: opened again, the project is turned away as any other.
    told.length = 0;
    await page.goto(`/#/s/${project}`);
    await expect.poll(() => told.join('\n')).toMatch(/招待は取り消されました/);
    await expect(page.locator('.rev-banner.refused')).toHaveCount(0);
    expect(storedPlace()).toEqual({ x: 0, y: 0 });
  } finally {
    await context.close();
  }
});
