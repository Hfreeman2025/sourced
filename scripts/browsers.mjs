// Launches the engines for the browser suites.
//
// By default this uses the repository's own Playwright and the engines installed
// for it in .cache/browsers (or PLAYWRIGHT_BROWSERS_PATH). Two overrides:
// SOURCED_BROWSER_CHANNEL runs Chromium from an installed browser such as Chrome
// (CI uses this), and SOURCED_PLAYWRIGHT_PACKAGE points Chromium at another
// Playwright installation's package.json.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const elsewhere = process.env.SOURCED_PLAYWRIGHT_PACKAGE;
const external =
  elsewhere && resolve(elsewhere) !== resolve('package.json')
    ? createRequire(resolve(elsewhere))('playwright')
    : undefined;
// Resolved before PLAYWRIGHT_BROWSERS_PATH is set, so it finds that installation's own engine.
const externalChromium = external?.chromium.executablePath();
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.cache/browsers');
const own = createRequire(resolve('package.json'))('playwright');

export async function launch(name) {
  if (name === 'chromium') {
    if (process.env.SOURCED_BROWSER_CHANNEL)
      return own.chromium.launch({ headless: true, channel: process.env.SOURCED_BROWSER_CHANNEL });
    if (external)
      return external.chromium.launch({ headless: true, executablePath: externalChromium });
    return own.chromium.launch({ headless: true });
  }
  if (name === 'webkit' || name === 'firefox') return own[name].launch({ headless: true });
  throw new Error(`Unknown browser: ${name}`);
}
