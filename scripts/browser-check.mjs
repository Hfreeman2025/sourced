import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch } from './browsers.mjs';
import { distributionContracts } from './browser/distribution-contracts.mjs';
const baseURL = process.env.SOURCED_URL ?? 'http://127.0.0.1:4177';
const pass = process.env.SOURCED_PASS ?? 'latest';
const names = (process.env.SOURCED_BROWSERS ?? 'chromium,webkit,firefox').split(',');
const root = `${process.env.SOURCED_BROWSER_ROOT ?? 'shots/browser'}/${pass}`;
await mkdir(root, { recursive: true });
const report = [];
const invalid =
  'source bill = "Example bill"\nlet energy = 10 kWh @bill\nlet mass = 2 kg @bill\nlet total = energy + mass\nprint "Broken: {total}"';
const undefinedScenario =
  'assume supplied = 1\nassume fixed = 0.9\nassume one = 1\nlet gap = supplied - fixed\nlet amount = one / gap\nprint "Ratio: {amount}"';
const longProgram =
  `source document = "${'Synthetic public example with a long reference title. '.repeat(7)}"\nlet mass = 123456.789 kg @document\nassume scale = 2\nlet adjusted = mass * scale\n` +
  Array.from(
    { length: 12 },
    (_, i) => `print "A deliberately long result name for output ${i + 1}: {adjusted as t}"`,
  ).join('\n');
for (const name of names) {
  const browser = await launch(name);
  const directory = `${root}/${name}`;
  await mkdir(directory, { recursive: true });
  try {
    for (const [size, viewport] of [
      ['wide', { width: 1440, height: 900 }],
      ['phone', { width: 390, height: 844 }],
    ]) {
      if (process.env.SOURCED_SIZE && process.env.SOURCED_SIZE !== size) continue;
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' }),
        page = await context.newPage();
      const errors = [],
        warnings = [],
        requests = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
        if (m.type() === 'warning') warnings.push(m.text());
      });
      page.on('request', (r) => requests.push(r.url()));
      const shot = async (state) => {
        if (!['derivation'].includes(state)) await page.evaluate(() => scrollTo(0, 0));
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.screenshot({ path: `${directory}/${state}-${size}.png` });
        if (size === 'phone' && ['derivation', 'commute', 'long-content'].includes(state))
          await page.screenshot({ path: `${directory}/${state}-${size}-full.png`, fullPage: true });
      };
      const checked = async () => {
        await page.waitForFunction(
          () =>
            !document.body.classList.contains('analysis-pending') &&
            document.querySelector('#check-status')?.textContent === 'Units checked',
        );
      };
      const chart = async (count) => {
        await checked();
        await page.waitForFunction(
          (n) =>
            document.querySelectorAll('.tornado-row').length === n &&
            /actual program reruns|Sobol from/.test(
              document.querySelector('#sensitivity-status')?.textContent ?? '',
            ),
          count,
        );
      };
      const setCode = async (code) => {
        await page.locator('.cm-content').focus();
        await page.keyboard.press('ControlOrMeta+a');
        if (code.length) await page.keyboard.insertText(code);
        else await page.keyboard.press('Backspace');
      };
      const home = async () => {
        if (size === 'phone') await page.locator('#example-select').selectOption('2');
        else await page.getByRole('tab', { name: 'Home energy', exact: true }).click();
        await page.locator('#reset-code').click();
        await chart(4);
      };
      const example = async (index) => {
        if (size === 'phone') await page.locator('#example-select').selectOption(String(index));
        else await page.locator('#examples .example-tab').nth(index).click();
        await checked();
      };
      await page.bringToFront();
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await distributionContracts({ page, size, viewport, chart, setCode, home, shot });
      const geometry = await page.evaluate(() => ({
        editor: document.querySelector('#editor').getBoundingClientRect().bottom,
        answer: document.querySelector('.answer-value').getBoundingClientRect().bottom,
        viewport: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.ok(geometry.editor < viewport.height && geometry.answer < viewport.height);
      assert.equal(geometry.overflow, false);
      await page.waitForFunction(
        () => performance.getEntriesByName('sourced-meaningful-paint').length > 0,
      );
      const meaningful = await page.evaluate(
        () => performance.getEntriesByName('sourced-meaningful-paint')[0]?.startTime,
      );
      assert.equal(typeof meaningful, 'number');
      await shot('ready');
      // Result hover and keyboard focus trace actual dependency tokens.
      await page.locator('#outputs .output-option').nth(1).hover();
      await page.waitForFunction(() => document.querySelectorAll('.dependency-token').length > 5);
      assert.match(
        await page
          .locator('.dependency-token')
          .allTextContents()
          .then((x) => x.join(' ')),
        /usage/,
      );
      await shot('trace');
      await page.mouse.move(2, 2);
      await page.locator('#outputs .output-option').nth(2).click();
      await chart(2);
      assert.match(await page.locator('#answer').textContent(), /16.12/);
      assert.match(await page.locator('#sensitivity').textContent(), /daily/);
      assert.doesNotMatch(await page.locator('#sensitivity').textContent(), /usage/);
      await home();
      // Drag directly on a live CodeMirror number. Test the result *before* release.
      const number = page.locator('.scrub-number[data-input="usage:0"]').first();
      const box = await number.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 6; step++) {
        await page.mouse.move(box.x + box.width / 2 + step * 5, box.y + box.height / 2);
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await page.waitForFunction(
        () => document.querySelector('.answer-value')?.textContent === '£93.05',
      );
      assert.match(await page.locator('.cm-content').textContent(), /314 kWh @bill/);
      assert.equal(await page.locator('#gesture-feedback').isVisible(), true);
      await shot('scrubbing');
      await page.mouse.up();
      await chart(4);
      assert.match(await page.locator('#edit-state').textContent(), /What-if/);
      await shot('scenario');
      await page.locator('.cm-content').focus();
      await page.keyboard.press('ControlOrMeta+z');
      await chart(4);
      const original = await page.locator('.cm-content').textContent();
      assert.match(original, /284 kWh @bill/);
      // Undoing past the drag reaches Reset's step intact, with no digits left behind.
      await page.keyboard.press('ControlOrMeta+z');
      await chart(4);
      assert.equal(await page.locator('.cm-content').textContent(), original);
      // A capital Z, as a real keyboard sends with Shift; Linux binds only Ctrl-Shift-z.
      await page.keyboard.press('ControlOrMeta+Shift+Z');
      await page.keyboard.press('ControlOrMeta+Shift+Z');
      await chart(4);
      assert.match(await page.locator('.cm-content').textContent(), /314 kWh @bill/);
      // Escape cancels the next gesture without changing units or source references.
      const after = page.locator('.scrub-number[data-input="usage:0"]');
      const nextBox = await after.boundingBox();
      assert.ok(nextBox);
      await page.mouse.move(nextBox.x + 5, nextBox.y + 5);
      await page.mouse.down();
      await page.mouse.move(nextBox.x + 25, nextBox.y + 5);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await chart(4);
      assert.match(await page.locator('.cm-content').textContent(), /314 kWh @bill/);
      // Cancelling a scheduled frame must not disable the next gesture.
      const resumed = await page.locator('.scrub-number[data-input="usage:0"]').boundingBox();
      assert.ok(resumed);
      await page.mouse.move(resumed.x + resumed.width / 2, resumed.y + resumed.height / 2);
      await page.mouse.down();
      await page.mouse.move(resumed.x + resumed.width / 2 + 5, resumed.y + resumed.height / 2);
      await page.waitForFunction(
        () => document.querySelector('.answer-value')?.textContent === '£94.28',
      );
      await page.mouse.up();
      await chart(4);
      // The numeric field is the keyboard and touch alternative.
      await page.locator('#quantity-input').fill('300');
      await page.locator('#quantity-input').press('Enter');
      await chart(4);
      assert.match(await page.locator('#answer').textContent(), /89.62/);
      await page.locator('#quantity-input').focus();
      await page.keyboard.press('ArrowUp');
      await chart(4);
      assert.match(await page.locator('.cm-content').textContent(), /301 kWh/);
      await page.locator('#quantity-input').fill('');
      assert.equal(await page.locator('#quantity-input').getAttribute('aria-invalid'), 'true');
      await shot('input-error');
      await page.locator('#quantity-input').press('Escape');
      await home();
      if (size === 'phone')
        await page.getByRole('tab', { name: 'Derivation', exact: true }).click();
      await page.locator('.diagram-node.source').first().click();
      assert.match(await page.locator('.diagram-detail').textContent(), /page 2/);
      await shot('derivation');
      await page.getByRole('button', { name: 'Find in code', exact: true }).click();
      assert.equal(await page.locator('.cm-content:focus').count(), 1);
      await page.keyboard.press('Escape');
      if (size === 'phone')
        await page.getByRole('tab', { name: 'Sensitivity', exact: true }).click();
      for (const [index, answer] of [
        [3, '28.39'],
        [4, '450'],
        [1, '9.86'],
        [0, '70.88'],
      ]) {
        await example(index);
        await page.waitForFunction(
          (value) => document.querySelector('.answer-value')?.textContent?.includes(value),
          answer,
        );
      }
      await chart(6);
      await shot('commute');
      await page.getByRole('button', { name: 'Reference', exact: true }).click();
      await shot('reference');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#guide-dialog').evaluate((d) => d.open), false);
      await page.getByRole('button', { name: 'JavaScript', exact: true }).click();
      assert.match(await page.locator('#compiled-code').textContent(), /rt.number/);
      await shot('javascript');
      await page.keyboard.press('Escape');
      await home();
      await page.locator('#outputs .output-option').nth(2).click();
      await checked();
      await setCode('assume only = 2 kg\nprint "Only: {only}"');
      await chart(1);
      assert.match(await page.locator('#answer').textContent(), /2 kg/);
      await setCode(invalid);
      await page.waitForFunction(
        () => document.querySelector('#check-status')?.textContent === '1 error',
      );
      assert.equal(await page.locator('.answer-value').count(), 0);
      assert.ok((await page.locator('.cm-lintRange-error').count()) > 0);
      await shot('error');
      await setCode('');
      await checked();
      assert.match(await page.locator('#answer').textContent(), /No calculation/);
      assert.equal(await page.locator('.answer-value').count(), 0);
      await shot('empty');
      await setCode(longProgram);
      await checked();
      await page.waitForFunction(() => document.querySelectorAll('.output-option').length === 12);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await shot('long-content');
      const manyInputs =
        Array.from({ length: 60 }, (_, i) => `assume x${i} = ${i + 1} kg`).join('\n') +
        `\nlet total = sum([${Array.from({ length: 60 }, (_, i) => `x${i}`).join(',')}])\nprint "Total: {total}"`;
      await setCode(manyInputs);
      await checked();
      await page.waitForFunction(() =>
        document.querySelector('#sensitivity-status')?.textContent.startsWith('60 inputs'),
      );
      assert.equal(await page.locator('.tornado-row').count(), 48);
      await page.getByRole('button', { name: 'Show all 60 ranked inputs' }).click();
      assert.equal(await page.locator('.tornado-row').count(), 60);
      assert.match(await page.locator('.tornado-row').first().textContent(), /x59/);
      await shot('many-inputs');
      await page.evaluate(() => {
        window.__dragEvents = [];
        for (const type of ['pointerdown', 'pointermove'])
          document.addEventListener(
            type,
            (e) =>
              window.__dragEvents.push({
                type,
                x: e.clientX,
                y: e.clientY,
                alt: e.altKey,
                shift: e.shiftKey,
                target: e.target.outerHTML.slice(0, 120),
              }),
            true,
          );
      });
      await setCode(`${'// long line\n'.repeat(150)}assume x = 2 kg\nprint "x: {x}"`);
      await chart(1);
      await page.evaluate(() => {
        scrollTo(0, 0);
        const scroller = document.querySelector('.cm-scroller');
        scroller.scrollTop = 0;
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.evaluate(() => {
        const scroller = document.querySelector('.cm-scroller');
        scroller.scrollTop = scroller.scrollHeight;
      });
      await page.locator('.scrub-number[data-input="x:0"]').waitFor();
      await page.waitForFunction(() => {
        const node = document.querySelector('.scrub-number[data-input="x:0"]'),
          scroller = document.querySelector('.cm-scroller');
        if (!node || !scroller) return false;
        const a = node.getBoundingClientRect(),
          b = scroller.getBoundingClientRect();
        return a.top >= b.top && a.bottom <= b.bottom && a.top >= 0 && a.bottom <= innerHeight;
      });
      await page.locator('.scrub-number[data-input="x:0"]').hover();
      const tail = await page.locator('.scrub-number[data-input="x:0"]').boundingBox();
      assert.ok(tail);
      await page.mouse.move(tail.x + tail.width / 2, tail.y + tail.height / 2);
      await page.mouse.down();
      await page.mouse.move(tail.x + tail.width / 2 + 5, tail.y + tail.height / 2);
      try {
        await page.waitForFunction(
          () => document.querySelector('.answer-value')?.textContent === '7 kg',
          null,
          { timeout: 5000 },
        );
      } catch (error) {
        console.log(
          JSON.stringify(
            {
              browser: name,
              size,
              tail,
              feedback: await page.locator('#gesture-feedback').textContent(),
              answer: await page.locator('#answer').textContent(),
              field: await page.locator('#quantity-input').inputValue(),
              events: await page.evaluate(() => window.__dragEvents),
              sourceTail: await page
                .locator('.cm-content')
                .textContent()
                .then((s) => s.slice(-120)),
            },
            null,
            2,
          ),
        );
        throw error;
      }
      await page.mouse.up();
      await chart(1);
      await shot('long-scroll');
      await setCode(undefinedScenario);
      await chart(3);
      assert.match(await page.locator('#sensitivity').textContent(), /Undefined/);
      await shot('undefined-sensitivity');
      await home();
      await context.setOffline(true);
      await page.waitForFunction(() => !navigator.onLine);
      await page.locator('#quantity-input').fill('300');
      await page.locator('#quantity-input').press('Enter');
      await chart(4);
      assert.match(await page.locator('#answer').textContent(), /89.62/);
      await shot('offline');
      await context.setOffline(false);
      await home();
      await shot('recovered');
      assert.deepEqual(errors, [], `${name} ${size} console errors`);
      assert.deepEqual(warnings, [], `${name} ${size} console warnings`);
      assert.deepEqual(
        requests.filter((url) => !url.startsWith(baseURL) && !url.startsWith(`blob:${baseURL}/`)),
        [],
      );
      report.push({
        browser: name,
        size,
        version: browser.version(),
        meaningfulPaintMs: Math.round(meaningful),
        meaningfulPaintUnder2s: meaningful < 2000,
        checks:
          'drag before release, cancellation, field keys, trace, sensitivity selection, derivation, 4 examples, errors, empty, long, undefined scenarios, offline, dialogs',
        errors,
        warnings,
        externalRequests: 0,
      });
      await writeFile(
        `${root}/browser-report.json`,
        `${JSON.stringify({ checkedAt: new Date().toISOString(), baseURL, report }, null, 2)}\n`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
// Designed initial slow-load and unsupported-worker states, without a fake calculation.
if (names.includes('chromium')) {
  const browser = await launch('chromium');
  try {
    for (const [size, viewport] of [
      ['wide', { width: 1440, height: 900 }],
      ['phone', { width: 390, height: 844 }],
    ]) {
      const directory = `${root}/chromium`,
        context = await browser.newContext({ viewport }),
        page = await context.newPage();
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/index-*.js', async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(baseURL, { waitUntil: 'commit' });
      await page.locator('.code-loading').waitFor();
      await page.waitForFunction(() => document.querySelector('#editor').clientHeight > 200);
      await page.screenshot({ path: `${directory}/loading-${size}.png` });
      assert.match(await page.locator('#result-state').textContent(), /Checking/);
      release();
      await page.waitForFunction(
        () => document.querySelector('#check-status')?.textContent === 'Units checked',
      );
      await context.close();
      const unsupported = await browser.newContext({ viewport });
      await unsupported.addInitScript(() => {
        Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
      });
      const fallback = await unsupported.newPage();
      const issues = [];
      fallback.on('pageerror', (e) => issues.push(e.message));
      await fallback.goto(baseURL, { waitUntil: 'networkidle' });
      await fallback.getByText('Analysis unavailable', { exact: true }).first().waitFor();
      await fallback.screenshot({ path: `${directory}/unavailable-${size}.png` });
      assert.deepEqual(issues, []);
      await unsupported.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${root}/browser-report.json`,
  `${JSON.stringify({ checkedAt: new Date().toISOString(), baseURL, report }, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
