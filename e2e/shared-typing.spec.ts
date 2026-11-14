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
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`/#/s/${project}?${new URLSearchParams({ server: server.url, token })}`);
  await expect(page.locator('.save-state')).toHaveText('共同編集先に保存済み');
  return page;
}

// The seeded shape: as wide as it was put down, and as tall as its text makes it.
const shape = (page: Page) => page.locator('#canvas rect[width="160"]').first();
/** Click the middle of the shape, as a person would: the text drawn on it takes no clicks of its own. */
async function clickShape(page: Page): Promise<void> {
  const at = (await shape(page).boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
}
/** Select the shape and open its text to type into (Enter): all of it is selected. */
async function edit(page: Page): Promise<void> {
  await clickShape(page);
  await reopen(page);
}
/** Open the text of the shape still selected (a second click this soon would be a double-click). */
async function reopen(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
}
const editor = (page: Page) => page.locator('.text-editor');
/** What the editor shows, line breaks and all. */
const shown = (page: Page) => editor(page).evaluate((el) => (el as HTMLElement).innerText.replace(/\n$/, ''));
/** The shape's text as the inspector shows it (to look at only, on a shared board). */
const textField = (page: Page) => page.locator('.inspector label.field', { hasText: 'テキスト' }).locator('textarea');
async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

test('two browsers type into one name at once, at different places, with a paste, a line break and a range deleted, and both keep all of it', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await edit(a);
  await a.keyboard.press('ArrowLeft');
  await a.keyboard.type('A');
  await edit(b);
  await b.keyboard.press('ArrowRight');
  await b.keyboard.type('B');
  await expect.poll(() => shown(a)).toBe('A図形B');
  await expect.poll(() => shown(b)).toBe('A図形B');

  // A selects 形; B types in front of it all, and A's selection stays on 形.
  await press(a, 'ArrowRight');
  await press(a, 'Shift+ArrowRight');
  await press(b, 'ArrowLeft', 5);
  await b.keyboard.type('C');
  await expect.poll(() => shown(a)).toBe('CA図形B');
  await a.keyboard.type('X');
  await expect.poll(() => shown(b)).toBe('CA図XB');

  // B pastes two lines after its C, A breaks the line after its X, and B deletes what it pasted on the second line.
  await b.evaluate((text) => navigator.clipboard.writeText(text), '貼り\r\n付け');
  await b.keyboard.press('ControlOrMeta+V');
  await a.keyboard.press('Enter');
  await expect.poll(() => shown(a)).toBe('C貼り\n付けA図X\nB');
  await expect.poll(() => shown(b)).toBe('C貼り\n付けA図X\nB');
  await press(b, 'Shift+ArrowLeft', 2);
  await b.keyboard.press('Backspace');
  await expect.poll(() => shown(a)).toBe('C貼り\nA図X\nB');

  await a.keyboard.press('ControlOrMeta+Enter');
  await b.keyboard.press('ControlOrMeta+Enter');
  await expect(editor(a)).toHaveCount(0);
  await expect(textField(a)).toHaveValue('C貼り\nA図X\nB');
  await expect(textField(b)).toHaveValue('C貼り\nA図X\nB');
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(b.locator('.save-state')).toHaveText('共同編集先に保存済み');
  const c = await openLink(browser);
  await clickShape(c);
  await expect(textField(c)).toHaveValue('C貼り\nA図X\nB');
});

test('each browser undoes only its own typing, Escape calling off only its own, and undo while typing takes back what it typed', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await edit(a);
  await a.keyboard.press('ArrowRight');
  await a.keyboard.type('a');
  await edit(b);
  await b.keyboard.press('ArrowLeft');
  await b.keyboard.type('b');
  await expect.poll(() => shown(a)).toBe('b図形a');
  await a.keyboard.press('ControlOrMeta+Enter');
  await expect(textField(a)).toHaveValue('b図形a');

  await a.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => shown(b)).toBe('b図形');
  await a.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => shown(b)).toBe('b図形a');

  await reopen(a);
  await a.keyboard.press('ArrowRight');
  await a.keyboard.type('c');
  await b.keyboard.type('d');
  await expect.poll(() => shown(a)).toBe('bd図形ac');
  await a.keyboard.press('Escape');
  await expect(editor(a)).toHaveCount(0);
  await expect.poll(() => shown(b)).toBe('bd図形a');

  await reopen(a);
  await a.keyboard.press('ArrowRight');
  await a.keyboard.type('e');
  await expect.poll(() => shown(b)).toBe('bd図形ae');
  await a.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => shown(a)).toBe('bd図形a');
  await expect.poll(() => shown(b)).toBe('bd図形a');
  await a.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => shown(b)).toBe('bd図形ae');
});

test('typing ends when the other browser deletes the shape, which stays deleted after an undo of the typing', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  const errors: string[] = [];
  a.on('pageerror', (e) => errors.push(e.message));
  await edit(a);
  await a.keyboard.type('消す');
  await clickShape(b);
  await b.keyboard.press('Delete');
  await expect(editor(a)).toHaveCount(0);
  await expect(shape(a)).toHaveCount(0);
  await expect(a.locator('.quickbar')).toHaveCount(0);
  await a.keyboard.type('x');
  await a.keyboard.press('ControlOrMeta+z');
  await expect(a.locator('.save-state')).toHaveText('共同編集先に保存済み');
  await expect(shape(a)).toHaveCount(0);
  await expect(shape(b)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a conversion under way is left alone while the other browser types, and goes down where it was typed', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await edit(a);
  await a.keyboard.press('ArrowRight');
  // Blink's own composition, as an IME drives it: a regression check, not a check of a real IME.
  const ime = await a.context().newCDPSession(a);
  await ime.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
  await edit(b);
  await b.keyboard.press('ArrowLeft');
  await b.keyboard.type('X');
  await expect.poll(() => shown(b)).toBe('X図形');
  await expect.poll(() => shown(a)).toBe('図形かん');
  await ime.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 });
  await ime.send('Input.insertText', { text: '漢' });
  await expect.poll(() => shown(a)).toBe('X図形漢');
  await expect.poll(() => shown(b)).toBe('X図形漢');
  await a.keyboard.type('Z');
  await expect.poll(() => shown(b)).toBe('X図形漢Z');
});

test('a comment typed on a shared board is listed and settled in the other browser', async ({ browser }) => {
  const a = await openLink(browser);
  const b = await openLink(browser);
  await a.locator('.toolbar button[aria-label^="付箋"]').click();
  const area = (await a.locator('#canvas').boundingBox())!;
  await a.mouse.click(area.x + area.width / 2 + 200, area.y + area.height / 2 + 120);
  await expect(editor(a)).toBeFocused();
  await a.keyboard.type('確認する');
  await a.keyboard.press('ControlOrMeta+Enter');
  await b.locator('.topbar button', { hasText: 'コメント' }).click();
  await expect(b.locator('.comments-panel li.comment b')).toHaveText('確認する');
  await b.locator('.comments-panel button.settle').click();
  await a.locator('.topbar button', { hasText: 'コメント' }).click();
  await expect(a.locator('.comments-panel')).toContainText('解決済み 1 件');
});

test('a board of this machine still takes typing as before: written once done, the box and its first text one step to undo', async ({ page }) => {
  await page.goto('/');
  await page.locator('.toolbar button[aria-label="四角"]').click();
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('手元');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('2行目');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('#canvas').getByText('2行目')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#canvas').getByText('手元')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('#canvas').getByText('手元')).toHaveCount(1);
});
