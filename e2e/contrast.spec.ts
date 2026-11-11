import { type Locator, type Page, expect, test } from '@playwright/test';

/**
 * The text in a part of the page that is below WCAG's contrast for its size: 4.5:1, or 3:1 from 24px
 * (18.66px bold). Its background is what is painted under it, half-transparent ones laid over white.
 * Text a disabled control dims needs no contrast.
 */
function faintText(part: Locator): Promise<string[]> {
  return part.evaluate((root) => {
    type Rgba = [number, number, number, number];
    const rgba = (css: string): Rgba => {
      const [r, g, b, a = 1] = css.match(/[\d.]+/g)!.map(Number);
      return [r, g, b, a];
    };
    const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
    const luminance = (c: Rgba) => {
      const [r, g, b] = c.slice(0, 3).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const under = (el: Element): Rgba => {
      const layers: Rgba[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = rgba(getComputedStyle(e).backgroundColor);
        if (bg[3] > 0) layers.unshift(bg);
        if (bg[3] >= 1) break;
      }
      return layers.reduce((c, layer) => over(layer, c), [255, 255, 255, 1] as Rgba);
    };
    const faint: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
      const style = getComputedStyle(el);
      if (!text || !el.getClientRects().length || style.visibility === 'hidden' || el.closest(':disabled, [aria-disabled="true"]')) continue;
      const bg = under(el);
      const [a, b] = [luminance(over(rgba(style.color), bg)), luminance(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      const px = parseFloat(style.fontSize);
      const large = px >= 24 || (Number(style.fontWeight) >= 700 && px >= 18.66);
      if (ratio < (large ? 3 : 4.5)) faint.push(`「${text}」 ${ratio.toFixed(2)}:1`);
    }
    return faint;
  });
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み');
}

test('the board settings, the board list, the search and the list tabs keep their small grey text readable on their tints', async ({ page }) => {
  await open(page);
  expect.soft(await faintText(page.locator('aside.inspector'))).toEqual([]);

  await page.getByRole('button', { name: '新しいボード' }).first().click();
  await expect(page.locator('.modal.boards .kind-card.on')).toBeVisible();
  expect.soft(await faintText(page.locator('.modal.boards'))).toEqual([]);
  await page.locator('.modal.boards header button').click();

  await page.keyboard.press('ControlOrMeta+f');
  await page.locator('.search-bar input').fill('HDMI');
  await expect(page.locator('.search-hit.on')).toBeVisible();
  expect.soft(await faintText(page.locator('.search-bar'))).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '機材・ケーブル表' }).click();
  await expect(page.locator('.lists .tabs button.on')).toBeVisible();
  expect.soft(await faintText(page.locator('.lists .tabs'))).toEqual([]);
});
