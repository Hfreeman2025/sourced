import assert from 'node:assert/strict';
import os from 'node:os';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { launch } from './browsers.mjs';
const baseURL = process.env.SOURCED_URL ?? 'http://127.0.0.1:4177';
const evidence = process.env.SOURCED_MEASUREMENT_DIR ?? 'shots/v3';
await mkdir(evidence, { recursive: true });
const assets = [];
for (const name of await readdir('dist/assets'))
  if (name.endsWith('.js')) {
    const bytes = await readFile(`dist/assets/${name}`);
    assets.push({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
  }
const results = [];
for (const name of (process.env.SOURCED_BROWSERS ?? 'chromium,webkit,firefox').split(',')) {
  const browser = await launch(name);
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'no-preference',
    });
    page.setDefaultTimeout(60000);
    await page.bringToFront();
    const issues = [];
    page.on('pageerror', (e) => issues.push(e.message));
    await page.addInitScript(() => {
      window.__layoutShifts = [];
      if (PerformanceObserver.supportedEntryTypes.includes('layout-shift'))
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            if (!entry.hadRecentInput) window.__layoutShifts.push(entry.value);
        }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => performance.getEntriesByName('sourced-meaningful-paint').length > 0,
    );
    // v3: the opener's 100,000-run distribution and its Sobol shares.
    await page.waitForFunction(() => performance.getEntriesByName('sourced-shares').length > 0);
    const opening = await page.evaluate(() => {
      const first = (name) => performance.getEntriesByName(name)[0];
      return {
        previewMs: Math.round(first('sourced-distribution-preview')?.startTime ?? -1),
        refinedMs: Math.round(first('sourced-distribution-refined')?.startTime ?? -1),
        refinedWorkerMs: first('sourced-distribution-refined')?.detail?.workerMs,
        sharesMs: Math.round(first('sourced-shares')?.startTime ?? -1),
        sharesWorkerMs: first('sourced-shares')?.detail?.workerMs,
        sobolRuns: first('sourced-shares')?.detail?.evaluations,
      };
    });
    const stages = await page.evaluate(() =>
      performance
        .getEntriesByType('mark')
        .filter((e) => e.name.startsWith('sourced-'))
        .map((e) => ({ name: e.name, ms: Math.round(e.startTime) })),
    );
    const meaningfulPaintMs = await page.evaluate(
      () => performance.getEntriesByName('sourced-meaningful-paint')[0].startTime,
    );
    const idleFrames = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const values = [];
          let last = 0;
          function tick(now) {
            if (last) values.push(now - last);
            last = now;
            if (values.length < 45) requestAnimationFrame(tick);
            else resolve(values);
          }
          requestAnimationFrame(tick);
        }),
    );
    await page.getByRole('tab', { name: 'The daily commute', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.tornado-row').length === 6 &&
        document.querySelector('#sensitivity-status')?.textContent.includes('Sobol from'),
    );
    await page.evaluate(() => {
      window.__activeFrames = [];
      window.__measuring = true;
      window.__visibleResults = [];
      window.__visibleDistributions = [];
      let last = 0;
      new MutationObserver(() => {
        const value = document.querySelector('.answer-value')?.textContent;
        if (value && !window.__visibleResults.includes(value)) window.__visibleResults.push(value);
      }).observe(document.querySelector('#answer'), {
        subtree: true,
        childList: true,
        characterData: true,
      });
      new MutationObserver(() => {
        const value = document.querySelector('.interval-line')?.textContent;
        if (value && !window.__visibleDistributions.includes(value))
          window.__visibleDistributions.push(value);
      }).observe(document.querySelector('#distribution'), { subtree: true, childList: true });
      function tick(now) {
        if (last) window.__activeFrames.push(now - last);
        last = now;
        if (window.__measuring) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const box = await page.locator('.scrub-number[data-input="consumption:0"]').boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++) {
      await page.mouse.move(box.x + box.width / 2 + i, box.y + box.height / 2);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const released = await page.evaluate(() => {
      performance.clearMarks('sourced-distribution-refined');
      performance.clearMarks('sourced-shares');
      return performance.now();
    });
    await page.mouse.up();
    await page.waitForFunction(() => !document.body.classList.contains('analysis-pending'));
    await page.waitForFunction(() => performance.getEntriesByName('sourced-shares').length > 0);
    const afterRelease = await page.evaluate((start) => {
      const refined = performance.getEntriesByName('sourced-distribution-refined').at(-1);
      const shares = performance.getEntriesByName('sourced-shares').at(-1);
      return {
        refinedMs: Math.round((refined?.startTime ?? start) - start),
        refinedWorkerMs: refined?.detail?.workerMs,
        sharesMs: Math.round((shares?.startTime ?? start) - start),
        sharesWorkerMs: shares?.detail?.workerMs,
      };
    }, released);
    const measurement = await page.evaluate(() => {
      window.__measuring = false;
      return {
        frames: window.__activeFrames,
        visibleUpdates: window.__visibleResults.length,
        visibleDistributions: window.__visibleDistributions.length,
        cls: window.__layoutShifts.reduce((a, b) => a + b, 0),
      };
    });
    const summary = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        samples: values.length,
        medianMs: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)),
        p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
        maxMs: Number(sorted.at(-1).toFixed(2)),
        over50ms: values.filter((x) => x > 50).length,
      };
    };
    assert.ok(
      measurement.visibleUpdates >= 15,
      `${name} only ${measurement.visibleUpdates} visible live updates`,
    );
    assert.deepEqual(issues, []);
    results.push({
      browser: name,
      stages,
      meaningfulPaintMs: Math.round(meaningfulPaintMs),
      idleFrameTime: summary(idleFrames),
      activeScrubFrameTime: summary(measurement.frames),
      visibleResultUpdates: measurement.visibleUpdates,
      visibleDistributionUpdates: measurement.visibleDistributions,
      opening,
      afterRelease,
      initialCLS: measurement.cls,
      note: 'Active measurement drags the commute’s fuel consumption while the result, its 4,096-run preview distribution, sensitivity and the technical diagram recompute every frame. After release: time to the 100,000-run distribution and Sobol shares. Worker milliseconds are compute time inside the worker. Idle frames provide the same-machine baseline.',
    });
  } finally {
    await browser.close();
  }
}
const report = {
  checkedAt: new Date().toISOString(),
  baseURL,
  meaningfulPaintDefinition:
    'First presented frame after validated interpreter results and the editor are present, measured from navigation start. Small programs evaluate directly; larger programs use the worker.',
  host: { load: os.loadavg(), logicalCPUs: os.cpus().length },
  jsShippedGzipBytes: assets.reduce((sum, a) => sum + a.gzipBytes, 0),
  assets,
  results,
};
report.budgets = results.map((result) => ({
  browser: result.browser,
  meaningfulUnder2s: result.meaningfulPaintMs < 2000,
  activeP95Under33ms: result.activeScrubFrameTime.p95Ms < 33,
}));
await writeFile(`${evidence}/performance.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
