import { launch } from './browsers.mjs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await launch('chromium');
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    reducedMotion: 'reduce',
  });
  const baseURL = process.env.SOURCED_URL ?? 'http://127.0.0.1:4177';
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.tornado-row').length === 6 &&
      document.querySelector('#sensitivity-status')?.textContent.includes('Sobol from') &&
      document.querySelector('.distribution-meta')?.textContent.includes('100,000 runs'),
  );
  await page.locator('#outputs .output-option').first().hover();
  await page.waitForFunction(() => document.querySelectorAll('.dependency-token').length > 20);
  await page.screenshot({ path: 'public/og.png' });
  const bytes = await readFile('public/og.png');
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  await copyFile('public/og.png', 'dist/og.png');
  await mkdir('shots', { recursive: true });
  await copyFile('public/og.png', 'shots/og.png');
  await writeFile(
    'shots/social-preview.json',
    `${JSON.stringify({ source: baseURL, viewport: { width: 1200, height: 630 }, method: 'Unedited screenshot of the real calculation pad: the commute opener with its 100,000-run distribution, tracing the computed result.', bytes: bytes.length }, null, 2)}\n`,
  );
  console.log('Real application social preview captured: public/og.png (1200×630).');
} finally {
  await browser.close();
}
