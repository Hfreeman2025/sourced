import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch } from './browsers.mjs';
const url = process.env.SOURCED_URL ?? 'http://127.0.0.1:4177';
const root = `${process.env.SOURCED_LAYOUT_ROOT ?? 'shots/v3/layout'}/${process.env.SOURCED_LAYOUT_PASS ?? 'pass-1'}`;
const report = [];
await mkdir(root, { recursive: true });
for (const name of (process.env.SOURCED_BROWSERS ?? 'chromium,webkit,firefox').split(',')) {
  const browser = await launch(name);
  try {
    for (const [size, viewport] of [
      ['wide', { width: 1440, height: 900 }],
      ['phone', { width: 390, height: 844 }],
    ]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (['error', 'warning'].includes(m.type())) errors.push(m.text());
      });
      await page.goto(url);
      const checked = () => page.waitForFunction(() =>
        document.querySelector('#check-status')?.textContent === 'Units checked' &&
        !document.body.classList.contains('analysis-pending') &&
        /actual program reruns|Sobol from/.test(document.querySelector('#sensitivity-status')?.textContent ?? ''));
      const outsidePanel = () => page.locator('.diagram-viewport').evaluate(viewport => {
        const r = viewport.getBoundingClientRect();
        return [...viewport.querySelectorAll('text, .diagram-hit')].filter(node => {
          const b = node.getBoundingClientRect();
          return b.left < r.left - 1 || b.right > r.right + 1 ||
            b.top < r.top - 1 || b.bottom > r.bottom + 1;
        }).map(node => node.textContent || node.getAttribute('class'));
      });
      const readable = async () => {
        const smallest = await page.locator('.technical-diagram text').evaluateAll(nodes =>
          Math.min(...nodes.map(node => parseFloat(getComputedStyle(node).fontSize) * node.getScreenCTM().a)));
        assert.ok(smallest >= 10.99, `Drawing text must stay at least 11px; got ${smallest}px`);
        return smallest;
      };
      const fittedView = async () => {
        await readable();
        const large = await page.locator('.diagram-viewport').getAttribute('data-large') === 'true';
        if (large) assert.ok(await page.locator('.diagram-scroll-hint').isVisible(), 'Large drawings need a visible scrolling hint');
        else assert.deepEqual(await outsidePanel(), [], 'Ordinary diagrams must fit without cropping or internal scrolling');
      };
      await checked();
      // The opener is now the commute; these lineage contracts are Home energy's.
      if (size === 'phone') await page.locator('#example-select').selectOption('2');
      else await page.locator('#examples .example-tab').nth(2).click();
      await checked();
      const detail = page.locator('#result-detail');
      assert.match(await detail.textContent(), /Sources@bill · @tariffAssumptionsdays/);
      if (size === 'wide') {
        const gap = await page.evaluate(() => {
          const value = document.querySelector('.answer-value').getBoundingClientRect();
          const summary = document.querySelector('.lineage-receipt').getBoundingClientRect();
          return summary.top - value.bottom;
        });
        assert.ok(gap < 60, `Lineage belongs beside the main figure, not at the panel foot: ${gap}`);
      }
      await page.locator('#outputs button').nth(1).click();
      assert.match(await detail.textContent(), /Sources@bill · @tariffAssumptionsNone/);
      await page.locator('#outputs button').nth(2).click();
      assert.match(await detail.textContent(), /Sources@tariffAssumptionsdays/);
      await page.locator('#outputs button').first().click();
      await page.locator('#quantity-input').fill('314');
      await page.locator('#quantity-input').press('Enter');
      await checked();
      assert.match(await detail.textContent(), /Base £85.70 · change \+£7.35/);
      assert.match(await detail.textContent(), /Sources@bill · @tariffAssumptionsdays/);
      await page.screenshot({ path: `${root}/${name}-${size}-scenario.png`, fullPage: size === 'phone' });
      await page.locator('#reset-code').click();
      await checked();
      for (const [example, index] of [['commute', 0], ['solar', 1], ['home', 2], ['trip', 3], ['recipe', 4]]) {
        if (size === 'phone') await page.locator('#example-select').selectOption(String(index));
        else await page.locator('#examples .example-tab').nth(index).click();
        await checked();
        const directory = `${root}/${name}`;
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: `${directory}/${example}-${size}.png`, fullPage: size === 'phone' });
        if (size === 'phone') await page.locator('#lineage-tab').click();
        // Exercise the hidden phone panel's first reveal before any output click
        // can redraw the graph with already-visible dimensions.
        await page.evaluate(() => new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await fittedView();
        if (example !== 'commute') assert.equal(await page.locator('.diagram-viewport').getAttribute('data-large'), 'false');
        await page.locator('#lineage-panel').screenshot({ path: `${directory}/${example}-opening-${size}.png` });
        for (let output = 0; output < 3; output++) {
          await page.locator('#outputs button').nth(output).click();
          await checked();
          await page.locator('.technical-diagram').waitFor({ state: 'visible' });
          const verify = async (zoom, expected, fitted = false) => {
            const actualScale = await page.locator('.technical-diagram').evaluate(drawing =>
              new DOMMatrixReadOnly(getComputedStyle(drawing).transform).a);
            if (expected !== undefined) assert.ok(Math.abs(actualScale - expected) < 0.001,
              `${zoom}: expected ${expected} scale, got ${actualScale}`);
            const controlsClear = await page.evaluate(() => {
              const drawing = document.querySelector('.diagram-viewport').getBoundingClientRect();
              const controls = document.querySelector('.diagram-controls').getBoundingClientRect();
              return controls.top >= drawing.bottom;
            });
            assert.ok(controlsClear, 'Zoom controls must not cover the drawing');
            const overlaps = await page.locator('.technical-diagram').evaluate((drawing) => {
              const texts = [...drawing.querySelectorAll('text')].map(t => ({
                text: t.textContent, node: t.closest('.diagram-node').dataset.node,
                rect: t.getBoundingClientRect(),
              }));
              return texts.flatMap((a, i) => texts.slice(i + 1).filter(b =>
                a.rect.left < b.rect.right - 0.5 && a.rect.right > b.rect.left + 0.5 &&
                a.rect.top < b.rect.bottom - 0.5 && a.rect.bottom > b.rect.top + 0.5,
              ).map(b => `${a.text} / ${b.text}`));
            });
            assert.deepEqual(overlaps, [], `${name} ${size} ${example}/${output} ${zoom}: text overlap`);
            // An uncertain terminal's distribution glyph never touches any annotation.
            const glyphHits = await page.locator('.technical-diagram').evaluate((drawing) => {
              const texts = [...drawing.querySelectorAll('text')].map(t => t.getBoundingClientRect());
              return [...drawing.querySelectorAll('.terminal-spread')].flatMap(glyph => {
                const g = glyph.getBoundingClientRect();
                return texts.filter(r => g.left < r.right - 0.5 && g.right > r.left + 0.5 &&
                  g.top < r.bottom - 0.5 && g.bottom > r.top + 0.5).map(() => glyph.closest('.diagram-node').dataset.node);
              });
            });
            assert.deepEqual(glyphHits, [], `${name} ${size} ${example}/${output} ${zoom}: glyph overlaps text`);
            const clipped = await page.locator('.technical-diagram').evaluate(drawing => {
              const bounds = drawing.getBoundingClientRect();
              return [...drawing.querySelectorAll('text')].filter(t => {
                const r = t.getBoundingClientRect();
                return r.left < bounds.left - 1 || r.right > bounds.right + 1 ||
                  r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1;
              }).map(t => t.textContent);
            });
            assert.deepEqual(clipped, [], `${example}/${output} ${zoom}: drawing clips labels`);
            if (fitted) {
              await fittedView();
            }
            const minTextPx = await readable();
            report.push({ browser: name, size, example, output, zoom, actualScale, minTextPx, overlaps: 0, clipped: 0 });
          };
          await verify('initial', undefined, true);
          const initialScale = await page.locator('.technical-diagram').evaluate(drawing =>
            new DOMMatrixReadOnly(getComputedStyle(drawing).transform).a);
          assert.ok(initialScale > 0 && initialScale <= 1, 'Opening fit must preserve native size or shrink');
          const maximumFit = await page.locator('.diagram-viewport').evaluate(viewport => {
            const style = getComputedStyle(viewport), drawing = viewport.querySelector('svg');
            return Math.max(11 / 12, Math.min(1,
              (viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1) / drawing.viewBox.baseVal.width));
          });
          assert.ok(Math.abs(initialScale - maximumFit) < 0.001, 'Opening drawing must fit width at a readable scale');
          if (example !== 'commute') {
            const usedWidth = await page.locator('.diagram-viewport').evaluate(viewport =>
              { const bounds = [...viewport.querySelectorAll('svg text, svg circle')].map(node => node.getBoundingClientRect());
                return (Math.max(...bounds.map(b => b.right)) - Math.min(...bounds.map(b => b.left))) / viewport.clientWidth; });
            const minimumUse = size === 'wide' ? (example === 'home' && output === 0 ? 0.85 : 0.8) : 0.7;
            assert.ok(usedWidth > minimumUse,
              `${name} ${size} ${example}/${output}: annotations must use the panel width; got ${usedWidth}, expected > ${minimumUse}`);
          }
          if (example === 'home' && output === 0) {
            const initialWidth = await page.locator('.technical-diagram').evaluate(drawing => drawing.viewBox.baseVal.width);
            await page.locator('#lineage').evaluate(container => {
              container.style.width = '2000px';
            });
            await page.waitForFunction(() =>
              document.querySelector('.technical-diagram').viewBox.baseVal.width > 1900 &&
              new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.technical-diagram')).transform).a === 1);
            await verify('native-room', 1, true);
            await page.locator('#lineage').evaluate(container => {
              container.style.width = '';
            });
            await page.waitForFunction(({ scale, width }) =>
              Math.abs(document.querySelector('.technical-diagram').viewBox.baseVal.width - width) < 1 &&
              Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.technical-diagram')).transform).a - scale) < 0.001,
              { scale: initialScale, width: initialWidth });
            await verify('restored-fit', initialScale, true);
          }
          if (!output) await page.locator('#lineage-panel').screenshot({ path: `${directory}/${example}-drawing-initial-${size}.png` });
          const terminals = await page.locator('.terminal').evaluateAll(nodes => nodes.map(n =>
            [...n.querySelectorAll('text')].map(t => t.textContent)));
          assert.ok(terminals.every(t => t.length === 3 && t.every(Boolean)), 'Each terminal owns a value, unit and reference line');
          if (example === 'home' && output === 0) assert.deepEqual(terminals, [
            ['284', 'kWh', '@bill'], ['0.245', '£/kWh', '@tariff'],
            ['0.52', '£/day', '@tariff'], ['31', 'day', 'assume days'],
          ]);
          for (let step = 0; step < 8; step++) {
            await page.getByRole('button', { name: '+', exact: true }).click();
            await verify(`enlarge-${step + 1}`, Math.min(2, initialScale + (step + 1) * 0.25));
          }
          for (let step = 0; step < 6; step++) {
            await page.getByRole('button', { name: '−', exact: true }).click();
            await verify(`reduce-${step + 1}`, Math.max(11 / 12, 2 - (step + 1) * 0.25));
          }
          await page.getByRole('button', { name: 'Fit', exact: true }).click();
          await page.waitForFunction(expected => Math.abs(new DOMMatrixReadOnly(
            getComputedStyle(document.querySelector('.technical-diagram')).transform).a - expected) < 0.001, initialScale);
          await verify('fit', initialScale, true);
          if (!output) {
            await page.locator('#lineage-panel').screenshot({ path: `${directory}/${example}-drawing-${size}.png` });
            await page.locator('.terminal').first().press('Enter');
            assert.ok(await page.getByRole('button', { name: 'Find in code', exact: true }).isVisible());
          }
        }
        if (size === 'phone') await page.locator('#sensitivity-tab').click();
      }
      assert.deepEqual(errors, [], 'No browser errors or warnings');
      await page.close();
    }
  } finally { await browser.close(); }
}
await writeFile(`${root}/layout-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.length} diagram geometry checks passed; all terminal blocks, examples, outputs, viewports and zoom steps.`);
