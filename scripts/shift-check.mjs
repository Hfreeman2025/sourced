// Cross-browser layout-shift check. The layout-shift API exists only in
// Chromium, so this also compares every landmark's box in the static HTML
// shell (JavaScript blocked, web fonts loaded) with the fully rendered page
// (results, distribution, Sobol shares and font swap complete). Any landmark
// that moves or resizes would shift the page while it loads.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch } from './browsers.mjs';
const url = process.env.SOURCED_URL ?? 'http://127.0.0.1:4177';
const out = process.env.SOURCED_SHIFT_DIR ?? 'shots/shift';
const landmarks = [
  '.masthead',
  '.example-bar',
  '.calculation',
  '#answer',
  '.answer-interval',
  '#distribution',
  '#result-detail',
  '#outputs',
  '.analysis-tabs',
  '#sensitivity-panel',
  '#lineage-panel',
];
const report = [];
await mkdir(out, { recursive: true });
for (const name of (process.env.SOURCED_BROWSERS ?? 'chromium,webkit,firefox').split(',')) {
  const browser = await launch(name);
  try {
    for (const [size, viewport] of [
      ['wide', { width: 1440, height: 900 }],
      ['phone', { width: 390, height: 844 }],
    ]) {
      const boxes = (page) =>
        page.evaluate(
          (selectors) =>
            Object.fromEntries(
              selectors.map((selector) => {
                const node = document.querySelector(selector);
                const box = node?.getBoundingClientRect();
                return [selector, box?.height ? [box.top, box.height] : null];
              }),
            ),
          landmarks,
        );
      const shell = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      await shell.route('**/*.{js,ts}', (route) => route.abort());
      await shell.goto(url);
      await shell.evaluate(() => document.fonts.ready);
      const before = await boxes(shell);
      await shell.close();
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      await page.addInitScript(() => {
        window.__cls = 0;
        if (PerformanceObserver.supportedEntryTypes.includes('layout-shift'))
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              if (!entry.hadRecentInput) window.__cls += entry.value;
          }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(url);
      await page.waitForFunction(() =>
        document.querySelector('#sensitivity-status')?.textContent?.includes('Sobol from'),
      );
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const after = await boxes(page);
      const supported = await page.evaluate(() =>
        PerformanceObserver.supportedEntryTypes.includes('layout-shift'),
      );
      const cls = supported ? await page.evaluate(() => window.__cls) : null;
      await page.close();
      // A shift is a box that starts in the first screen and moves. A box that
      // grows downward moves nothing by itself; if it pushed anything, the
      // next landmark's position catches it.
      const moved = landmarks.filter((selector) => {
        const a = before[selector],
          b = after[selector];
        if (!a || !b || a[0] >= viewport.height) return false;
        return Math.abs(a[0] - b[0]) > 0.5;
      });
      report.push({ browser: name, size, cls, moved, before, after });
      console.log(
        `${name} ${size}: CLS ${cls === null ? 'n/a (no layout-shift API)' : cls}; landmarks moved: ${moved.length ? moved.join(', ') : 'none'}`,
      );
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${out}/shift.json`,
  `${JSON.stringify({ checkedAt: new Date().toISOString(), url, report }, null, 2)}\n`,
);
for (const row of report) {
  assert.deepEqual(row.moved, [], `${row.browser} ${row.size}: landmarks moved while loading`);
  if (row.cls !== null) assert.equal(row.cls, 0, `${row.browser} ${row.size}: CLS`);
}
