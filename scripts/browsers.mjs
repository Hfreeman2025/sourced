import { createRequire } from 'node:module';
import { resolve } from 'node:path';
if (
  process.env.SOURCED_PLAYWRIGHT_PACKAGE &&
  resolve(process.env.SOURCED_PLAYWRIGHT_PACKAGE) === resolve('package.json')
)
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.cache/browsers');
const provided = createRequire(
  process.env.SOURCED_PLAYWRIGHT_PACKAGE ??
    '<local path>',
)('playwright');
const executable = provided.chromium.executablePath();
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.cache/browsers');
const own = createRequire(resolve('package.json'))('playwright');
export async function launch(name) {
  if (name === 'chromium')
    return provided.chromium.launch({
      headless: true,
      ...(process.env.SOURCED_BROWSER_CHANNEL
        ? { channel: process.env.SOURCED_BROWSER_CHANNEL }
        : { executablePath: executable }),
    });
  if (name === 'webkit' || name === 'firefox') return own[name].launch({ headless: true });
  throw new Error(`Unknown browser: ${name}`);
}
