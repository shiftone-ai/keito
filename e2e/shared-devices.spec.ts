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

/** A browser of its own (no storage shared with the others) following the project's join link; what it is asked is kept in `asked`, and agreed to. */
async function openLink(browser: Browser): Promise<{ page: Page; asked: string[] }> {
  const page = await (await browser.newContext()).newPage();
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token })}`);
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  return { page, asked };
}

const tab = (page: Page, title: string) => page.locator('.board-tabs .board-tab:not(.add)').filter({ hasText: title });
/** A device the board shows, by its name. */
const device = (page: Page, name: string) => page.locator('#canvas').getByText(name, { exact: true });
const inspector = (page: Page) => page.locator('.inspector');
/** An input of the inspector by its label. */
const field = (page: Page, label: string, what = 'input') => inspector(page).locator('label.field', { hasText: label }).locator(what);

async function clickOn(page: Page, what: Locator): Promise<void> {
  const at = (await what.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
}
/** Add a board of a kind from the ＋ beside the tabs: it is opened. */
async function addBoard(page: Page, title: string, kind: string): Promise<void> {
  await page.locator('.board-tab.add').click();
  await page.locator('.new-board .kind-card', { hasText: kind }).click();
  const name = page.locator('.new-board input[placeholder^="ボードの名前"]');
  await name.fill(title);
  await name.press('Enter');
  await expect(tab(page, title)).toHaveClass(/\bon\b/);
}
/** Put a device from the library on the board, (dx, dy) from the middle of the canvas. */
async function putDevice(page: Page, name: string, dx: number, dy: number): Promise<void> {
  if (!(await page.locator('.library-top input').isVisible())) await page.locator('.toolbar button[aria-label$="ライブラリ"]').click();
  await page.locator('.library-top input').fill(name);
  const item = (await page.locator('.library .item', { has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) }).boundingBox())!;
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(item.x + 20, item.y + item.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + dx, area.y + area.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  await expect(device(page, name)).toHaveCount(1);
}
/** The rows of the network list as the lists panel shows them; the panel is closed again (it covers the lower part of the board). */
async function networkRows(page: Page): Promise<string[]> {
  const panel = page.locator('.topbar-end button', { hasText: /機材・ケーブル表|通信一覧/ });
  await panel.click();
  await page.locator('.lists .tabs button', { hasText: 'ネットワーク' }).click();
  const rows = await page.locator('.lists table tbody tr').evaluateAll((all) => all.map((r) => [...r.querySelectorAll('td:not(.grip)')].slice(0, 3).map((td) => td.textContent).join(' ')));
  await panel.click();
  return rows;
}
/** Give the selected device an IP from the inspector. */
async function typeIp(page: Page, ip: string): Promise<void> {
  await field(page, 'IP アドレス').fill(ip);
  await field(page, 'IP アドレス').press('Enter');
}

/** On the system board a PC, and on a second system board a PC linked to it from the inspector: browser a on the second, b on the first. */
async function onTwoBoards(browser: Browser) {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await putDevice(a.page, 'PC', 0, -120);
  await expect(device(b.page, 'PC')).toHaveCount(1);
  await addBoard(a.page, '裏', 'システム図');
  await putDevice(a.page, 'PC', 0, 0);
  await clickOn(a.page, device(a.page, 'PC'));
  await inspector(a.page).locator('.shared-suggest button', { hasText: 'つなぐ' }).click();
  await expect(inspector(a.page).locator('.shared-list li', { hasText: '配置' })).toHaveCount(1);
  return { a, b };
}

test('two browsers keep a PC placed on two boards as one: an IP given on one board is on the other board too, and deleting it from all boards says what goes and one undo brings it back', async ({ browser }) => {
  const { a, b } = await onTwoBoards(browser);
  // The name is typed on the board: the inspector's field, written whole, is not taken on a shared board yet.
  await expect(field(a.page, '名称', 'textarea')).toBeDisabled();

  await clickOn(b.page, device(b.page, 'PC'));
  await typeIp(b.page, '192.168.0.10');
  await expect(field(a.page, 'IP アドレス')).toHaveValue('192.168.0.10');
  expect(await networkRows(a.page)).toEqual(['PC  192.168.0.10']);
  expect(await networkRows(b.page)).toEqual(['PC  192.168.0.10']);

  await clickOn(a.page, device(a.page, 'PC'));
  await inspector(a.page).locator('button', { hasText: 'すべてのボードから削除' }).click();
  await expect(device(a.page, 'PC')).toHaveCount(0);
  await expect(device(b.page, 'PC')).toHaveCount(0);
  expect(a.asked).toHaveLength(1);
  expect(a.asked[0]).toContain('「PC」をすべてのボードから削除しますか？');
  expect(a.asked[0]).toContain('2 枚のボードにある「PC」2 個');

  await a.page.keyboard.press('ControlOrMeta+z');
  await expect(device(a.page, 'PC')).toHaveCount(1);
  await expect(device(b.page, 'PC')).toHaveCount(1);
  // Not clicked again on either page: a second click on the PC this soon is a double-click, which opens its name.
  expect(await networkRows(b.page)).toEqual(['PC  192.168.0.10']);

  // The name typed on the second board is the system board's too, beside the IP given there. The PC is all that board has.
  await a.page.keyboard.press('ControlOrMeta+a');
  await a.page.keyboard.press('Enter');
  await expect(a.page.locator('.text-editor')).toBeFocused();
  await a.page.keyboard.press('End');
  await a.page.keyboard.type('-1');
  await a.page.keyboard.press('ControlOrMeta+Enter');
  await expect(device(b.page, 'PC-1')).toHaveCount(1);
  expect(await networkRows(b.page)).toEqual(['PC-1  192.168.0.10']);
  await expect(b.page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(a.page.locator('.save-state')).toHaveText('共同編集先に保存済み');
});

test("software on a third board runs on the shared PC, showing its host name and IP as they are now and listing them as the system board does; with the PC deleted it has no host", async ({ browser }) => {
  const { a, b } = await onTwoBoards(browser);
  await clickOn(b.page, device(b.page, 'PC'));
  await typeIp(b.page, '192.168.0.10');

  await addBoard(a.page, 'ソフト', 'ソフトウェア構成図');
  await putDevice(a.page, 'TouchDesigner', 0, 0);
  await clickOn(a.page, device(a.page, 'TouchDesigner'));
  const host = field(a.page, '動作ホスト', 'select');
  await host.selectOption((await host.locator('optgroup[label^="配置"] option').first().getAttribute('value'))!);
  const derived = inspector(a.page).locator('.hint', { hasText: '動作ホストの機材から' });
  await expect(derived).toHaveText('ホスト名 PC／IP 192.168.0.10（動作ホストの機材から）');

  await typeIp(b.page, '192.168.0.11');
  await expect(derived).toHaveText('ホスト名 PC／IP 192.168.0.11（動作ホストの機材から）');
  expect(await networkRows(a.page)).toEqual(['TouchDesigner PC 192.168.0.11']);
  expect(await networkRows(b.page)).toEqual(['PC  192.168.0.11']);

  await inspector(b.page).locator('button', { hasText: 'すべてのボードから削除' }).click();
  await expect(device(b.page, 'PC')).toHaveCount(0);
  await expect(derived).toHaveText('ホスト名 —／IP —（動作ホストの機材から）');
  await expect(host.locator('option:checked')).toHaveText('見つからない機材');
});
