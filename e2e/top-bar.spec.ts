import { expect, test } from '@playwright/test';

test('the top bar of a narrow window keeps each word on one line and every button in sight', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  await page.goto('/');
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み');
  const bar = await page.locator('.topbar').evaluate((top) => {
    const words = document.createRange();
    words.selectNodeContents(top.querySelector('.save-state')!);
    return { lines: words.getClientRects().length, cut: top.scrollWidth - top.clientWidth };
  });
  expect(bar).toEqual({ lines: 1, cut: 0 });
  await expect(page.locator('.topbar .export-btn')).toBeInViewport({ ratio: 1 });
});
