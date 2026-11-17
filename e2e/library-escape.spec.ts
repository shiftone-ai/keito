import { type Page, expect, test } from '@playwright/test';

/** Add a board of a kind to the project of the board on screen, from the ＋ beside the tabs; it is opened. */
async function addBoard(page: Page, kind: string, title: string): Promise<void> {
  await page.locator('.board-tab.add').click();
  await page.locator('.new-board .kind-card', { hasText: kind }).click();
  const name = page.locator('.new-board input[placeholder^="ボードの名前"]');
  await name.fill(title);
  await name.press('Enter');
  await expect(page.locator('.board-tabs .board-tab.on')).toHaveText(title);
}

test('Escape closes the comments on a board whose kind has no library though the library was left open on a system board, where it is open still', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み');
  await addBoard(page, 'システム図', '機材のあるボード');
  await page.keyboard.press('l');
  await expect(page.locator('.library')).toBeVisible();

  await addBoard(page, '自由ボード', '機材のないボード');
  await expect(page.locator('.library')).toHaveCount(0);
  await page.locator('.topbar-end button', { hasText: 'コメント' }).click();
  await expect(page.locator('.comments-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.comments-panel')).toHaveCount(0);

  await page.locator('.board-tabs .board-tab', { hasText: '機材のあるボード' }).click();
  await expect(page.locator('.library')).toBeVisible();
});
