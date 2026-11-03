import assert from 'node:assert/strict';
import { launch } from './browsers.mjs';
import { writeFile } from 'node:fs/promises';
const browser = await launch(process.env.SOURCED_CONTRAST_BROWSER ?? 'chromium');
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(process.env.SOURCED_URL ?? 'http://127.0.0.1:4177', { waitUntil: 'networkidle' });
await page.waitForFunction(() =>
  /actual program reruns|Sobol from/.test(
    document.querySelector('#sensitivity-status')?.textContent ?? '',
  ),
);
const check = () => {
  function rgb(text) {
    const m = text.match(/[\d.]+/g);
    return m ? m.map(Number) : [0, 0, 0, 0];
  }
  function luminance(color) {
    return color
      .slice(0, 3)
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  }
  const failures = [];
  let count = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (
      !(el instanceof HTMLElement) ||
      !el.checkVisibility() ||
      !Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
    )
      continue;
    const style = getComputedStyle(el);
    if (style.opacity === '0') continue;
    let ancestor = el;
    let background;
    while (ancestor) {
      background = rgb(getComputedStyle(ancestor).backgroundColor);
      if ((background[3] ?? 1) > 0) break;
      ancestor = ancestor.parentElement;
    }
    const fg = luminance(rgb(style.color)),
      bg = luminance(background ?? [255, 255, 255]);
    const contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    const threshold =
      parseFloat(style.fontSize) >= 24 ||
      (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
        ? 3
        : 4.5;
    count++;
    if (contrast + 0.005 < threshold)
      failures.push({
        text: el.textContent?.slice(0, 90),
        class: el.className,
        contrast: Number(contrast.toFixed(2)),
        color: style.color,
        background,
        threshold,
      });
  }
  return { count, failures };
};
const main = await page.evaluate(check);
await page.getByRole('button', { name: 'Reference' }).click();
const guide = await page.evaluate(check);
const report = { main, guide };
await writeFile('shots/v3/contrast.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
await browser.close();
assert.deepEqual(main.failures, [], 'Playground text contrast');
assert.deepEqual(guide.failures, [], 'Language guide text contrast');
