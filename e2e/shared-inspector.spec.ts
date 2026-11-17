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

/** A browser of its own (no storage shared with the others) following the project's join link; the errors of its page are kept in `errors`. */
async function openLink(browser: Browser): Promise<Page & { errors: string[] }> {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = Object.assign(await context.newPage(), { errors: [] as string[] });
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token })}`);
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  return page;
}

const saved = (page: Page) => expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
const inspector = (page: Page) => page.locator('.inspector');
/** A box of the inspector by its label. */
const field = (page: Page, label: string, what = 'textarea') => inspector(page).locator('label.field', { hasText: label }).locator(what);
// The seeded shape: as wide as it was put down, and as tall as its text makes it.
const shape = (page: Page) => page.locator('#canvas rect[width="160"]').first();
const editor = (page: Page) => page.locator('.text-editor');
/** What the board's editor shows, line breaks and all. */
const shown = (page: Page) => editor(page).evaluate((el) => (el as HTMLElement).innerText.replace(/\n$/, ''));
/** A device the board shows, by its name. */
const device = (page: Page, name: string) => page.locator('#canvas').getByText(name, { exact: true });
const tab = (page: Page, title: string) => page.locator('.board-tabs .board-tab:not(.add)').filter({ hasText: title });

/** Click the middle of something on the board, as a person would: the text drawn on it takes no clicks of its own. */
async function clickOn(page: Page, what: Locator): Promise<void> {
  const at = (await what.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
}
/** Focus a box of the inspector with the caret at `from` (its end by default), or `from` to `to` selected. */
async function focusAt(box: Locator, from?: number, to = from): Promise<void> {
  await box.focus();
  await box.evaluate((el: HTMLInputElement, [a, b]) => el.setSelectionRange(a ?? el.value.length, b ?? el.value.length), [from, to]);
}
const selected = (box: Locator) => box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
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
/** The rows of a list as the lists panel shows them, tabs between their cells; the panel is closed again (it covers the lower part of the board). */
async function listRows(page: Page, list: string): Promise<string[]> {
  const panel = page.locator('.topbar-end button', { hasText: '機材・ケーブル表' });
  await panel.click();
  await page.locator('.lists .tabs button', { hasText: list }).click();
  const rows = await page.locator('.lists tbody tr').allInnerTexts();
  await panel.click();
  return rows;
}

test('the board and the inspector type into one name at once: the inspector keeps its caret and selection, takes a paste and a line break, and leaving either writes nothing over the other’s letters', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  // A types on the board, in front of the name; B in the inspector, at its end.
  await clickOn(a, shape(a));
  await a.keyboard.press('Enter');
  await expect(editor(a)).toBeFocused();
  await a.keyboard.press('ArrowLeft');
  await clickOn(b, shape(b));
  const text = field(b, 'テキスト');
  await focusAt(text);
  await b.keyboard.type('B');
  await a.keyboard.type('A');
  await expect.poll(() => shown(a)).toBe('A図形B');
  await expect(text).toHaveValue('A図形B');
  expect(await selected(text)).toEqual([4, 4]);

  // B has 形 selected; A types in front of it, and B's selection stays on 形.
  await focusAt(text, 2, 3);
  await a.keyboard.type('C');
  await expect(text).toHaveValue('AC図形B');
  expect(await selected(text)).toEqual([3, 4]);
  await b.keyboard.type('X');
  await expect.poll(() => shown(a)).toBe('AC図XB');

  // B pastes two lines after its X and breaks the line.
  await b.evaluate((pasted) => navigator.clipboard.writeText(pasted), '貼り\r\n付け');
  await b.keyboard.press('ControlOrMeta+V');
  await b.keyboard.press('Enter');
  await expect(text).toHaveValue('AC図X貼り\n付け\nB');
  await expect.poll(() => shown(a)).toBe('AC図X貼り\n付け\nB');

  // B clicks off the shape while A types on (the field goes with the selection), then A leaves the board's editor: each keeps the other's letters.
  await a.keyboard.type('Z');
  await expect(text).toHaveValue('ACZ図X貼り\n付け\nB');
  const area = (await b.locator('#canvas').boundingBox())!;
  await b.mouse.click(area.x + area.width - 40, area.y + 40);
  await expect(text).toHaveCount(0);
  await a.keyboard.type('Y');
  await a.keyboard.press('ControlOrMeta+Enter');
  await expect(editor(a)).toHaveCount(0);
  await clickOn(b, shape(b));
  for (const page of [a, b]) {
    await expect(field(page, 'テキスト')).toHaveValue('ACZY図X貼り\n付け\nB');
    await saved(page);
  }

  // Kept: a browser opening the project anew shows the same.
  const c = await openLink(browser);
  await clickOn(c, shape(c));
  await expect(field(c, 'テキスト')).toHaveValue('ACZY図X貼り\n付け\nB');
  expect([...a.errors, ...b.errors]).toEqual([]);
});

test('undo in the inspector’s field takes back what was typed there, and once the field is left one undo takes back all of it, the other browser’s letters staying', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await clickOn(a, shape(a));
  const mine = field(a, 'テキスト');
  await focusAt(mine);
  await a.keyboard.type('a');
  await clickOn(b, shape(b));
  const theirs = field(b, 'テキスト');
  await focusAt(theirs, 0);
  await b.keyboard.type('b');
  await expect(mine).toHaveValue('b図形a');

  await a.keyboard.press('ControlOrMeta+z');
  await expect(mine).toHaveValue('b図形');
  await expect(theirs).toHaveValue('b図形');
  await a.keyboard.press('ControlOrMeta+Shift+z');
  await expect(theirs).toHaveValue('b図形a');

  // Left, then typed into again: two steps, each taken back whole by an undo on the board.
  await a.keyboard.press('Escape');
  await focusAt(mine);
  await a.keyboard.type('c');
  await expect(theirs).toHaveValue('b図形ac');
  await a.keyboard.press('Escape');
  await expect(mine).not.toBeFocused();
  await a.keyboard.press('ControlOrMeta+z');
  await expect(theirs).toHaveValue('b図形a');
  await a.keyboard.press('ControlOrMeta+z');
  await expect(theirs).toHaveValue('b図形');
  await expect(mine).toHaveValue('b図形');
  await a.keyboard.press('ControlOrMeta+Shift+z');
  await expect(theirs).toHaveValue('b図形a');
});

test('a device’s name, note and port names typed in the inspector are on the board and in the lists of both browsers, beside the move and the IP the other gave it; Enter in a port’s name ends a step to undo', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await putDevice(a, 'PC', 0, -120);
  await expect(device(b, 'PC')).toHaveCount(1);
  await clickOn(a, device(a, 'PC'));
  await clickOn(b, device(b, 'PC'));

  // At once: A names it and its first port, B notes it, gives it an IP and moves it.
  await focusAt(field(a, '名称'));
  await a.keyboard.type('-1');
  await focusAt(field(b, '備考'));
  await b.keyboard.type('予備機');
  await field(b, 'IP アドレス', 'input').fill('192.168.0.10');
  await b.keyboard.press('Escape');
  const before = (await device(b, 'PC-1').boundingBox())!;
  await b.keyboard.press('Shift+ArrowRight');
  const port = inspector(a).locator('.port-row input').first();
  await focusAt(port, 0);
  await a.keyboard.type('本線 ');
  await a.keyboard.press('Enter');
  await a.keyboard.type('仮 ');
  await expect(inspector(b).locator('.port-row input').first()).toHaveValue('本線 仮 LAN');
  await a.keyboard.press('Escape');
  await a.keyboard.press('ControlOrMeta+z');

  for (const page of [a, b]) {
    await expect(field(page, '名称')).toHaveValue('PC-1');
    await expect(field(page, '備考')).toHaveValue('予備機');
    await expect(field(page, 'IP アドレス', 'input')).toHaveValue('192.168.0.10');
    await expect(inspector(page).locator('.port-row input').first()).toHaveValue('本線 LAN');
    await expect(page.locator('#canvas').getByText('本線 LAN', { exact: true })).toHaveCount(1);
    await expect.poll(async () => (await device(page, 'PC-1').boundingBox())!.x - before.x).toBeGreaterThan(0);
    await saved(page);
    const [row] = await listRows(page, '機材リスト');
    expect(row).toContain('PC-1');
    expect(row).toContain('予備機');
    expect((await listRows(page, 'ネットワーク'))[0]).toContain('192.168.0.10');
  }
  expect((await device(a, 'PC-1').boundingBox())!.x).toBe((await device(b, 'PC-1').boundingBox())!.x);
});

test('a cable’s label and note typed in the inspector by two browsers are on the board and in the cable list of both, and a legend takes its heading and the name of the cable’s row', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await putDevice(a, 'PC', -250, 120);
  await putDevice(a, 'プロジェクター', 250, 120);
  await a.locator('.toolbar button[aria-label$="ライブラリ"]').click();
  // The PC's outputs come after its inputs (LAN, USB, AC): HDMI 1 is the fourth.
  const from = (await a.locator('#canvas circle.port-hit').nth(3).boundingBox())!;
  const to = (await device(a, 'プロジェクター').boundingBox())!;
  await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await a.mouse.up();
  const line = (page: Page) => page.locator('#canvas path[stroke="transparent"]');
  await expect(line(b)).toHaveCount(1);

  // The line just pulled is selected in A; B picks it from the cable list.
  await focusAt(field(a, '文（改行できます）'));
  await a.keyboard.type('本線');
  await b.locator('.topbar-end button', { hasText: '機材・ケーブル表' }).click();
  await b.locator('.lists .tabs button', { hasText: 'ケーブルリスト' }).click();
  await b.locator('.lists tbody tr').first().locator('td').nth(2).click();
  await b.locator('.topbar-end button', { hasText: '機材・ケーブル表' }).click();
  await focusAt(field(b, '文（改行できます）'), 0);
  await b.keyboard.type('主 ');
  await focusAt(field(b, '備考'));
  await b.keyboard.type('予備あり');
  await b.keyboard.press('Escape');
  await a.keyboard.press('Escape');

  for (const page of [a, b]) {
    await expect(field(page, '文（改行できます）')).toHaveValue('主 本線');
    await expect(field(page, '備考')).toHaveValue('予備あり');
    await expect(page.locator('#canvas').getByText('主 本線')).toHaveCount(1);
    await saved(page);
    const [row] = await listRows(page, 'ケーブルリスト');
    expect(row).toContain('主 本線');
    expect(row).toContain('予備あり');
  }

  // A legend lists the cable's colour: its heading and the row's name (not there until typed) are typed in the inspector.
  await a.locator('.toolbar button[aria-label="凡例を置く"]').click();
  const area = (await a.locator('#canvas').boundingBox())!;
  await a.mouse.click(area.x + area.width / 2, area.y + area.height / 2 - 150);
  await focusAt(field(a, '空にすると見出しを出しません', 'input'));
  await a.keyboard.type('（本番）');
  await focusAt(inspector(a).locator('.legend-row input:not([type="checkbox"])').first());
  await a.keyboard.type('映像の線');
  await a.keyboard.press('Escape');
  await expect(b.locator('#canvas').getByText('凡例（本番）')).toHaveCount(1);
  await expect(b.locator('#canvas').getByText('映像の線')).toHaveCount(1);
  await saved(a);
  expect([...a.errors, ...b.errors]).toEqual([]);
});

test('a conversion under way in an inspector field is left alone while the other browser types into the same text, and goes down where it was typed, in a one-line field and in one of several lines', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await putDevice(a, 'PC', 0, -120);
  await expect(device(b, 'PC')).toHaveCount(1);
  await clickOn(a, device(a, 'PC'));
  await clickOn(b, device(b, 'PC'));
  // Blink's own composition, as an IME drives it: a regression check, not a check of a real IME.
  const ime = await a.context().newCDPSession(a);

  for (const [mine, theirs, was] of [
    [field(a, '名称'), field(b, '名称'), 'PC'],
    [inspector(a).locator('.port-row input').first(), inspector(b).locator('.port-row input').first(), 'LAN'],
  ] as const) {
    await focusAt(mine);
    await ime.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
    await focusAt(theirs, 0);
    await b.keyboard.type('X');
    await expect(theirs).toHaveValue(`X${was}`);
    // B's letter has reached A's board, and A's field is as the conversion left it.
    await expect(a.locator('#canvas').getByText(`X${was}`, { exact: true })).toHaveCount(1);
    await expect(mine).toHaveValue(`${was}かん`);
    await ime.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 });
    await ime.send('Input.insertText', { text: '漢' });
    await expect(mine).toHaveValue(`X${was}漢`);
    await expect(theirs).toHaveValue(`X${was}漢`);
    expect(await selected(mine)).toEqual([was.length + 2, was.length + 2]);
    await a.keyboard.type('Z');
    await expect(theirs).toHaveValue(`X${was}漢Z`);
    await a.keyboard.press('Escape');
    await b.keyboard.press('Escape');
  }
  expect([...a.errors, ...b.errors]).toEqual([]);
});

test('typing in the inspector ends when the other browser takes off what is typed into: the keys that follow do nothing to the board, and nothing comes back after an undo', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await putDevice(a, 'PC', 0, -120);
  await expect(device(b, 'PC')).toHaveCount(1);
  await clickOn(a, device(a, 'PC'));
  await clickOn(b, device(b, 'PC'));

  // B takes the port off while A is in its name. The PC is still there: A's next keys must not rename or delete it.
  await focusAt(inspector(a).locator('.port-row input').first());
  await a.keyboard.type('x');
  await expect(inspector(b).locator('.port-row input').first()).toHaveValue('LANx');
  await inspector(b).locator('.port-row').first().locator('button[title="削除"]').click();
  await expect(a.locator('#canvas').getByText('LANx', { exact: true })).toHaveCount(0);
  await a.keyboard.type('y');
  await a.keyboard.press('Backspace');
  await expect(editor(a)).toHaveCount(0);
  for (const page of [a, b]) await expect(device(page, 'PC')).toHaveCount(1);

  // B deletes the PC while A is in its note.
  await clickOn(a, device(a, 'PC'));
  await focusAt(field(a, '備考'));
  await a.keyboard.type('消す');
  await expect(field(b, '備考')).toHaveValue('消す');
  await b.keyboard.press('Delete');
  await expect(device(a, 'PC')).toHaveCount(0);
  await expect(field(a, '備考')).toHaveCount(0);
  await a.keyboard.type('x');
  await a.keyboard.press('ControlOrMeta+z');
  await saved(a);
  for (const page of [a, b]) await expect(device(page, 'PC')).toHaveCount(0);
  expect([...a.errors, ...b.errors]).toEqual([]);
});

test('a name being typed in the inspector, a conversion under way in it, goes on into the shared device once the other browser makes its device one with it, and both boards then type into the one name, each keeping its own note and undoing its own typing', async ({ browser }) => {
  const [a, b] = await Promise.all([openLink(browser), openLink(browser)]);
  await putDevice(a, 'PC', 0, -120);
  await expect(device(b, 'PC')).toHaveCount(1);
  // A second system board with a PC of its own, A in its name; B, on the first board, makes its PC one with it.
  await a.locator('.board-tab.add').click();
  await a.locator('.new-board .kind-card', { hasText: 'システム図' }).click();
  await a.locator('.new-board input[placeholder^="ボードの名前"]').fill('裏');
  await a.locator('.new-board input[placeholder^="ボードの名前"]').press('Enter');
  await expect(tab(a, '裏')).toHaveClass(/\bon\b/);
  await putDevice(a, 'PC', 0, 0);
  await clickOn(a, device(a, 'PC'));
  await focusAt(field(a, '名称'));
  // Blink's own composition, as an IME drives it: a regression check, not a check of a real IME.
  const ime = await a.context().newCDPSession(a);
  await ime.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
  await clickOn(b, device(b, 'PC'));
  await inspector(b).locator('.shared-suggest button', { hasText: 'つなぐ' }).click();
  await expect(inspector(b).locator('.shared-list li', { hasText: '裏' })).toHaveCount(1);
  await expect(inspector(a).locator('.shared-list li', { hasText: '配置' })).toHaveCount(1);

  // The conversion is as it was, and goes down in the shared name; A types on in the field it was in, B in front of the name from its board.
  await expect(field(a, '名称')).toBeFocused();
  await expect(field(a, '名称')).toHaveValue('PCかん');
  await ime.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 });
  await ime.send('Input.insertText', { text: '漢' });
  await expect(device(b, 'PC漢')).toHaveCount(1);
  await a.keyboard.type('-1');
  await focusAt(field(b, '名称'), 0);
  await b.keyboard.type('主 ');
  for (const page of [a, b]) {
    await expect(field(page, '名称')).toHaveValue('主 PC漢-1');
    await expect(device(page, '主 PC漢-1')).toHaveCount(1);
  }
  // The note is the second board's alone.
  await focusAt(field(a, '備考'));
  await a.keyboard.type('裏の予備');
  await a.keyboard.press('Escape');
  await b.keyboard.press('Escape');
  await saved(a);
  await expect(field(b, '備考')).toHaveValue('');

  // Each undo takes back what was typed on its own board: A's note, then A's letters of the name; B's stay until B undoes.
  await a.keyboard.press('ControlOrMeta+z');
  await expect(field(a, '備考')).toHaveValue('');
  await a.keyboard.press('ControlOrMeta+z');
  for (const page of [a, b]) await expect(field(page, '名称')).toHaveValue('主 PC');
  await b.keyboard.press('ControlOrMeta+z');
  for (const page of [a, b]) await expect(field(page, '名称')).toHaveValue('PC');
  expect([...a.errors, ...b.errors]).toEqual([]);
});
