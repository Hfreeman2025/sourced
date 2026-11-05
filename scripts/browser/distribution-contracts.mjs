// Answers as distributions, checked in the browser on the commute opener: the
// 100,000-run distribution and its receipt, a drag drawn in the same frame with
// no layout shift, a draggable spread bound, reseeding, a terminal's spread, the
// exact state and its one-click spread, an invalid spread, and recovery.
import assert from 'node:assert/strict';

export async function distributionContracts({ page, size, viewport, chart, setCode, home, shot }) {
  const refined = () =>
    page.waitForFunction(() =>
      document.querySelector('.distribution-meta')?.textContent?.includes('100,000 runs'),
    );
  const shares = () =>
    page.waitForFunction(() =>
      document.querySelector('#sensitivity-status')?.textContent?.includes('Sobol from'),
    );
  // The opener: the commute's answer is a distribution, with cited and assumed spreads.
  await chart(6);
  await refined();
  await shares();
  assert.match(await page.locator('#answer').textContent(), /70\.88 kg/);
  const interval = await page.locator('.interval-line').textContent();
  const [p5, p95] = [...interval.matchAll(/between ([\d,.]+) and ([\d,.]+) kg/g)][0]
    .slice(1)
    .map((m) => Number(m.replaceAll(',', '')));
  assert.ok(p5 < 70.88 && 70.88 < p95, `90% interval brackets the central answer: ${interval}`);
  assert.match(
    await page.locator('.distribution-plot').getAttribute('aria-label'),
    /5th percentile .* median .* 95th percentile/,
  );
  assert.match(
    await page.locator('.distribution-meta').textContent(),
    /\d% of runs beyond the drawing/,
  );
  assert.match(
    await page.locator('#result-detail').textContent(),
    /Spreadscited @ipcc · @heat; assumed density · consumption · daily/,
  );
  assert.match(
    await page.locator('.share-finding').textContent(),
    /Knowing consumption exactly would remove about \d+% of the variance\. Cited spreads account for/,
  );
  assert.match(await page.locator('.tornado-row', { hasText: 'workdays' }).textContent(), /fixed/);
  const consumptionShare = Number(
    (
      await page
        .locator('.tornado-row', { hasText: 'consumption' })
        .locator('.share-value')
        .textContent()
    ).match(/(\d+)%/)?.[1],
  );
  assert.ok(consumptionShare > 70, `consumption dominates the variance: ${consumptionShare}%`);
  const opening = await page.evaluate(() => ({
    plot: document.querySelector('.distribution-plot').getBoundingClientRect().bottom,
    finding: document.querySelector('.share-finding').getBoundingClientRect().bottom,
  }));
  if (size === 'wide')
    assert.ok(
      opening.plot < viewport.height && opening.finding < viewport.height,
      'distribution and variance finding sit in the opening screen',
    );
  else assert.ok(opening.plot < viewport.height, 'the distribution is in the opening phone screen');
  await shot('opening');
  // Drag consumption: the distribution moves with the number on every frame,
  // and nothing above it shifts.
  const top = () =>
    page.evaluate(() =>
      Math.round(document.querySelector('#distribution').getBoundingClientRect().top),
    );
  await page.locator('.scrub-number[data-input="consumption:0"]').first().scrollIntoViewIfNeeded();
  const rest = await top();
  const startAnswer = await page.locator('.answer-value').textContent();
  const consumption = await page
    .locator('.scrub-number[data-input="consumption:0"]')
    .first()
    .boundingBox();
  assert.ok(consumption);
  await page.mouse.move(
    consumption.x + consumption.width / 2,
    consumption.y + consumption.height / 2,
  );
  await page.mouse.down();
  const lagging = [];
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(
      consumption.x + consumption.width / 2 + step * 3,
      consumption.y + consumption.height / 2,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const [answer, caption] = await page.evaluate(() => [
      document.querySelector('.answer-value')?.textContent,
      document.querySelector('.distribution-caption')?.textContent,
    ]);
    if (!caption?.endsWith(answer ?? '')) lagging.push(`${answer} vs ${caption}`);
  }
  assert.notEqual(
    await page.locator('.answer-value').textContent(),
    startAnswer,
    'the drag changed the answer',
  );
  assert.deepEqual(
    lagging,
    [],
    'the preview distribution is drawn in the same frame as the number',
  );
  assert.match(
    await page.locator('.distribution-meta').textContent(),
    /Preview · 4,096 runs while you adjust/,
  );
  if (size === 'wide') assert.equal(await top(), rest, 'no layout shift while dragging');
  await shot('distribution-drag');
  await page.mouse.up();
  await refined();
  await shares();
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await chart(6);
  await refined();
  assert.match(await page.locator('.cm-content').textContent(), /consumption = 0\.065 L\/km/);
  // A spread's own bounds are draggable: widen IPCC's upper limit, and P95 rises.
  const before95 = await page.locator('.distribution-value').last().textContent();
  await page.locator('.scrub-number[data-input="emission:0:high"]').scrollIntoViewIfNeeded();
  const high = await page.locator('.scrub-number[data-input="emission:0:high"]').boundingBox();
  assert.ok(high);
  await page.mouse.move(high.x + high.width / 2, high.y + high.height / 2);
  await page.mouse.down();
  await page.mouse.move(high.x + high.width / 2 + 80, high.y + high.height / 2);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.mouse.up();
  await refined();
  assert.match(await page.locator('.cm-content').textContent(), /95% 67500\.\.(?!73000)\d+ @ipcc/);
  assert.notEqual(await page.locator('.distribution-value').last().textContent(), before95);
  await page.locator('#reset-code').click();
  await chart(6);
  await refined();
  // Reseeding shows Monte Carlo noise; the same seed reproduces the same runs.
  const p50 = await page.locator('.distribution-value').nth(1).textContent();
  await page.getByRole('button', { name: 'Reseed', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.distribution-meta')?.textContent?.includes('seed 2'),
  );
  await refined();
  const reseeded = await page.locator('.distribution-value').nth(1).textContent();
  assert.ok(
    Math.abs(Number(reseeded.match(/[\d.]+$/)[0]) - Number(p50.match(/[\d.]+$/)[0])) < 0.6,
    `${p50} vs ${reseeded}`,
  );
  // Terminal detail names the spread, its shape and who stands behind it.
  if (size === 'phone') await page.getByRole('tab', { name: 'Derivation', exact: true }).click();
  await page.locator('.diagram-node.source').first().click();
  assert.match(
    await page.locator('.diagram-detail').textContent(),
    /Spread ~ 95% 67500\.\.73000 · two-piece normal · cited @ipcc/,
  );
  await shot('spread-detail');
  if (size === 'phone') await page.getByRole('tab', { name: 'Sensitivity', exact: true }).click();
  await home();
  assert.match(await page.locator('#answer').textContent(), /85.70/);
  // An exact result says so, and offers one undoable way to add a spread.
  assert.match(
    await page.locator('#distribution').textContent(),
    /Exact\. No input behind this result declares an uncertainty/,
  );
  await shot('exact');
  await page.locator('.suggestion-button').click();
  await chart(4);
  await refined();
  assert.match(await page.locator('.cm-content').textContent(), /284 kWh @bill ~ ±10% assumed/);
  assert.match(await page.locator('#result-detail').textContent(), /assumed usage/);
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await chart(4);
  assert.doesNotMatch(await page.locator('.cm-content').textContent(), /~ ±10%/);
  // A spread that excludes its value is an explicit error, not a quiet clamp.
  await setCode('assume t = 70 kg ~ 80..100 assumed\nprint "t: {t}"');
  await page.waitForFunction(
    () => document.querySelector('#check-status')?.textContent === '1 error',
  );
  assert.match(await page.locator('#answer').textContent(), /The range excludes the value/);
  assert.equal(await page.locator('.distribution-plot').count(), 0);
  await shot('spread-error');
  await home();
  await page.locator('#reset-code').click();
  await chart(4);
  assert.match(await page.locator('#answer').textContent(), /85.70/);
  assert.equal(
    await page.locator('#outputs .error-hint').count(),
    0,
    'no stale error hint after recovery',
  );
}
