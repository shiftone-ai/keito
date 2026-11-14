import { rmSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page, type Route, expect, test } from '@playwright/test';
import { type RunningServer, administer, seedData, startServer } from '../test/collab';

let data: string;
let server: RunningServer;
let project: string;
let token: string;

test.beforeEach(async () => {
  const seeded = seedData('free');
  ({ data, token } = seeded);
  project = seeded.seed.id;
  server = await startServer(data);
});

test.afterEach(async () => {
  await server.kill();
  rmSync(data, { recursive: true, force: true });
});

/** A page of `context` (a browser of its own: nothing kept is shared with the others) following the project's join link (the editor's, else `credential`'s). */
async function openLink(context: BrowserContext, credential = token): Promise<Page> {
  const page = await context.newPage();
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token: credential })}`);
  await expect(page.locator('.board-switch')).toHaveText(/（共有中）/);
  return page;
}
const newBrowser = async (browser: Browser) => openLink(await browser.newContext());

/** An SVG file, as a person would pick one. */
const svgFile = (text: string) => ({
  name: `${text}.svg`,
  mimeType: 'image/svg+xml',
  buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#2563eb"/><text x="20" y="70" font-size="28" fill="#fff">${text}</text></svg>`),
});

/** Put a picture on the board with the toolbar's button. */
async function insert(page: Page, file: ReturnType<typeof svgFile>): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.toolbar button[aria-label="画像・SVG を埋め込む"]').click();
  await (await chooser).setFiles(file);
}

/** The picture shown on the board, its bytes on the page. */
const shown = (page: Page) => page.locator('#canvas image[href^="blob:"]');
/** What the board says in place of a picture not on the page. */
const placeholder = (page: Page) => page.locator('#canvas .picture-state text');
/** What the board says of how the sending of a picture put on the board here stands. */
const badge = (page: Page) => page.locator('#canvas .picture-badge text');
/** The text of the SVG a page shows, read back from its bytes there. */
const shownText = (page: Page) => shown(page).evaluate(async (image) => (await fetch(image.getAttribute('href')!)).text());

/** Picture requests of `method` from `context` answered by `how` (by the time it is asked), else let through. */
async function pictureRequests(context: BrowserContext, method: string, how: (route: Route) => Promise<void>): Promise<void> {
  await context.route(/\/pictures\//, (route) => (route.request().method() === method ? how(route) : route.continue()));
}
const failWith = (status: number) => (route: Route) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });

test('a picture put on a shared board is shown in another browser that has no copy of it, to a viewer too, stays after the server restarts, and goes for everyone when deleted', async ({ browser }) => {
  const a = await newBrowser(browser);
  const b = await newBrowser(browser);
  await insert(a, svgFile('配置図'));
  await expect(shown(a)).toHaveCount(1);
  await expect(badge(a)).toHaveCount(0);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');

  await expect(shown(b)).toHaveCount(1);
  expect(await shownText(b)).toContain('配置図');

  const viewer = administer(data, (store) => store.addGrant(project, 'viewer'));
  const v = await openLink(await browser.newContext(), viewer.token);
  await expect(shown(v)).toHaveCount(1);
  await expect(v.locator('.toolbar button[aria-label="画像・SVG を埋め込む"]')).toHaveCount(0);

  await server.kill();
  server = await startServer(data, server.port);
  const c = await newBrowser(browser);
  await expect(shown(c)).toHaveCount(1);
  expect(await shownText(c)).toContain('配置図');

  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み', { timeout: 20_000 });
  await shown(a).click();
  await a.keyboard.press('Delete');
  await expect(shown(a)).toHaveCount(0);
  await expect(shown(b)).toHaveCount(0);
  await expect(shown(c)).toHaveCount(0);
});

test('a picture not yet sent says so, one failing to send says so and is sent again, and one that cannot be fetched leaves the board to be edited', async ({ browser }) => {
  const context = await browser.newContext();
  let holding = true;
  let answer: (route: Route) => Promise<void> = (route) => route.continue();
  const waiting: (() => void)[] = [];
  // Held while `holding`, then answered as `answer` says by then.
  await pictureRequests(context, 'PUT', async (route) => {
    if (holding) await new Promise<void>((go) => waiting.push(go));
    await answer(route);
  });
  const a = await openLink(context);
  const b = await newBrowser(browser);
  await insert(a, svgFile('先に届く'));
  await expect(badge(a)).toHaveText('送信中');
  await expect(placeholder(b)).toHaveText('画像の到着待ち');

  [holding, answer] = [false, failWith(503)];
  waiting.splice(0).forEach((go) => go());
  await expect(badge(a)).toHaveText('送信できていません');
  await expect(a.locator('.save-state')).toContainText('共同編集先に保存できていません');
  await expect(placeholder(b)).toHaveText('画像の到着待ち');

  await context.unroute(/\/pictures\//);
  await a.locator('.save-state button', { hasText: 'もう一度' }).click();
  await expect(badge(a)).toHaveCount(0);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(shown(b)).toHaveCount(1);

  // Another browser whose fetches of pictures fail: it says so, and the picture is moved there and stored as ever.
  const other = await browser.newContext();
  await pictureRequests(other, 'GET', (route) => route.abort());
  const d = await openLink(other);
  await expect(placeholder(d)).toHaveText('画像を取得できていません');
  const was = Number(await shown(b).getAttribute('x'));
  const at = (await d.locator('#canvas .picture-state rect').boundingBox())!;
  await d.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await d.mouse.down();
  await d.mouse.move(at.x + at.width / 2 + 120, at.y + at.height / 2 + 60, { steps: 8 });
  await d.mouse.up();
  await expect(d.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect.poll(async () => Number(await shown(b).getAttribute('x'))).toBeGreaterThan(was);
});

test('a picture put on the board while the server is down is kept in the browser, and sent once after the page is reloaded', async ({ browser }) => {
  const a = await newBrowser(browser);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await server.kill();
  await expect(a.locator('.save-state')).toHaveText('オフライン');
  await insert(a, svgFile('オフライン'));
  await expect(badge(a)).toHaveText('未送信');
  await expect(a.locator('.save-state')).toContainText('オフライン・未送信 2 件');
  await expect(a.locator('.save-state small')).toHaveText('本端末に保存済み');

  await a.reload();
  await expect(a.locator('.board-switch')).toHaveText(/（共有中）/);
  await expect(shown(a)).toHaveCount(1);
  await expect(badge(a)).toHaveText('未送信');

  server = await startServer(data, server.port);
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み', { timeout: 30_000 });
  await expect(badge(a)).toHaveCount(0);
  const b = await newBrowser(browser);
  await expect(shown(b)).toHaveCount(1);
  expect(await shownText(b)).toContain('オフライン');
});

test('a picture laid under the drawing of a shared board is made lighter and brought back up by someone who did not lay it there', async ({ browser }) => {
  const a = await newBrowser(browser);
  const b = await newBrowser(browser);
  await insert(a, svgFile('平面図'));
  await a.locator('.inspector button', { hasText: '下敷きにする' }).click();
  /** The picture laid under the drawing, as the board draws it. */
  const underlay = (page: Page) => page.locator('#canvas g[pointer-events="none"]:has(image[href^="blob:"])');
  await expect(underlay(b)).toHaveCount(1);

  const row = b.locator('.inspector .underlay');
  await row.locator('input[type="range"]').press('ArrowLeft');
  await expect(underlay(a)).toHaveAttribute('opacity', '0.5');
  await row.getByRole('button', { name: 'やめる' }).click();
  await expect(underlay(a)).toHaveCount(0);
  await expect(shown(a)).toHaveCount(1);
});

test('a picture replaced on a shared board with a file of another name is shown in another browser, under the name it had', async ({ browser }) => {
  const a = await newBrowser(browser);
  const b = await newBrowser(browser);
  await insert(a, svgFile('配置図'));
  await expect(shown(b)).toHaveCount(1);

  const chooser = a.waitForEvent('filechooser');
  await a.locator('.inspector button', { hasText: '画像を差し替え' }).click();
  await (await chooser).setFiles(svgFile('改訂版'));
  await expect.poll(() => shownText(b)).toContain('改訂版');
  await expect(a.locator('.inspector label.field', { hasText: '名前' }).locator('input')).toHaveValue('配置図');
});
