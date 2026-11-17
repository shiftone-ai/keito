import { type Page, expect, test } from '@playwright/test';

/** What the list on show offers to change: cells to fill, rows to drag by, the order to put back. */
const listEdits = (page: Page) => page.locator('.lists td.editable, .lists .grip, .lists td.handle, .lists .list-tool');

test('a state from the history on screen offers no cell to fill and no row to drag in the lists, leaves Escape to the lists though the library was left open, and still offers its project a new board', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み');
  // A system board of its own, with a device for the lists to show.
  await page.locator('.board-tab.add').click();
  const title = page.locator('.new-board input[placeholder^="ボードの名前"]');
  await title.fill('履歴の確認');
  await title.press('Enter');
  await expect(page.locator('.board-tabs .board-tab.on')).toHaveText('履歴の確認');
  await page.keyboard.press('l');
  await page.locator('.library-top input').fill('PC');
  const item = (await page.locator('.library .item', { has: page.locator('.label', { hasText: /^PC$/ }) }).boundingBox())!;
  const area = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(item.x + 20, item.y + item.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2, { steps: 10 });
  await page.mouse.up();
  // Out of the library's search, then off the device: the board settings, with the history, are shown.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.topbar-end button', { hasText: '機材・ケーブル表' }).click();
  await expect(listEdits(page).first()).toBeVisible();
  await page.keyboard.press('l');
  await expect(page.locator('.library')).toBeVisible();

  await page.locator('.revisions h4 button', { hasText: '名前を付けて残す' }).click();
  await page.locator('.rev-form input').fill('提出');
  await page.locator('.rev-form input').press('Enter');
  await page.locator('.rev.named', { hasText: '提出' }).getByRole('button', { name: '開く' }).click();
  await expect(page.locator('.rev-banner')).toBeVisible();
  await expect(page.locator('.lists tbody tr').first()).toBeVisible();
  await expect(listEdits(page)).toHaveCount(0);
  await expect(page.locator('.library')).toHaveCount(0);
  await expect(page.locator('.board-tab.add')).toHaveCount(1);
  await page.keyboard.press('l');
  await page.keyboard.press('Escape');
  await expect(page.locator('.lists')).toHaveCount(0);

  await page.locator('.rev-banner button', { hasText: '現在の図に戻る' }).click();
  await expect(page.locator('.library')).toBeVisible();
});
