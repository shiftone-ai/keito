import { type Locator, type Page, expect, test } from '@playwright/test';

/**
 * Each text in `part` short of WCAG's contrast for its size (4.5:1; 3:1 from 24px, or 18.66px bold),
 * as "element 「text」 ratio". Reads only text nodes (not input values, placeholders or `::after`),
 * and skips text that is not shown or that a disabled control holds. The colour is taken with its
 * elements' opacity; the background is the elements' background colours under it, over white
 * (background images and siblings drawn underneath are not seen).
 */
function faintText(part: Locator): Promise<string[]> {
  return part.evaluate((root) => {
    type Rgba = [number, number, number, number];
    const rgba = (css: string): Rgba => {
      const [r, g, b, a = 1] = css.match(/[\d.]+/g)!.map(Number);
      return [r, g, b, a];
    };
    const over = (top: Rgba, under: Rgba): Rgba => {
      const mix = (i: number) => top[i] * top[3] + under[i] * (1 - top[3]);
      return [mix(0), mix(1), mix(2), 1];
    };
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
      return layers.reduce((c, layer) => over(layer, c), [255, 255, 255, 1]);
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const faint: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
      const style = getComputedStyle(el);
      const shown = opacity(el);
      if (!text || !el.getClientRects().length || style.visibility === 'hidden' || !shown || el.closest(':disabled, [aria-disabled="true"]')) continue;
      const bg = under(el);
      const [r, g, b, a] = rgba(style.color);
      const [x, y] = [luminance(over([r, g, b, a * shown], bg)), luminance(bg)].sort((p, q) => q - p);
      const ratio = (x + 0.05) / (y + 0.05);
      const px = parseFloat(style.fontSize);
      const large = px >= 24 || (Number(style.fontWeight) >= 700 && px >= 18.66);
      if (ratio < (large ? 3 : 4.5)) faint.push(`${[el.tagName.toLowerCase(), ...el.classList].join('.')} 「${text}」 ${ratio.toFixed(2)}:1`);
    }
    return faint;
  });
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  // Not the 5 s default: as the first spec of a run on a loaded machine, it has waited longer than that.
  await expect(page.locator('.save-state')).toHaveText('フォルダに保存済み', { timeout: 30_000 });
}

test('the board settings, the tab strip, the board list, the search, a field error and the list tabs keep their text at WCAG contrast', async ({ page }) => {
  await open(page);
  expect.soft(await faintText(page.locator('aside.inspector'))).toEqual([]);
  expect.soft(await faintText(page.locator('nav.board-tabs'))).toEqual([]);

  await page.getByRole('button', { name: '新しいボード' }).first().click();
  await expect(page.locator('.modal.boards .kind-card.on')).toBeVisible();
  expect.soft(await faintText(page.locator('.modal.boards'))).toEqual([]);
  await page.locator('.modal.boards header button').click();

  await page.keyboard.press('ControlOrMeta+f');
  await page.locator('.search-bar input').fill('HDMI');
  await expect(page.locator('.search-hit.on')).toBeVisible();
  expect.soft(await faintText(page.locator('.search-bar'))).toEqual([]);

  await page.locator('.search-bar input').fill('映像再生PC');
  await page.keyboard.press('Enter');
  await page.getByLabel('型番のリンク（製品ページなど）').fill('not a link');
  await expect(page.locator('aside.inspector .error')).toBeVisible();
  expect.soft(await faintText(page.locator('aside.inspector'))).toEqual([]);

  await page.getByRole('button', { name: '機材・ケーブル表' }).click();
  await expect(page.locator('.lists .tabs button.on')).toBeVisible();
  expect.soft(await faintText(page.locator('.lists .tabs'))).toEqual([]);
});
