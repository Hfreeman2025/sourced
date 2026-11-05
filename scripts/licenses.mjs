import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
const allowed = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  '(MIT OR CC0-1.0)',
  '(MIT OR Unlicense)',
  'MIT OR Apache-2.0',
]);
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function jsonRecord(text, label) {
  const value = JSON.parse(text);
  if (!record(value)) throw new Error(`${label} must contain an object`);
  return value;
}
const lock = jsonRecord(await readFile('package-lock.json', 'utf8'), 'Lockfile');
if (!record(lock.packages)) throw new Error('Lockfile packages must be an object');
const rows = [];
const violations = [];
let installed = 0;
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path) continue;
  if (!record(info)) throw new Error(`Invalid lockfile entry: ${path}`);
  const fallbackName = path.split('node_modules/').at(-1);
  let present = true;
  try {
    await stat(join(path, 'package.json'));
  } catch (error) {
    if (error.code === 'ENOENT' && info.optional === true) present = false;
    else throw error;
  }
  if (!present) {
    if (typeof info.license !== 'string' || !allowed.has(info.license))
      violations.push(
        `${fallbackName}: unapproved optional dependency licence ${info.license ?? 'UNKNOWN'}`,
      );
    rows.push({
      name: fallbackName,
      version: info.version,
      license: info.license,
      installed: false,
    });
    continue;
  }
  const pkg = jsonRecord(await readFile(join(path, 'package.json'), 'utf8'), path);
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string')
    throw new Error(`Invalid package identity in ${path}`);
  const license =
    typeof pkg.license === 'string'
      ? pkg.license
      : record(pkg.license)
        ? pkg.license.type
        : undefined;
  if (!allowed.has(license)) violations.push(`${pkg.name}: ${license ?? 'UNKNOWN'}`);
  // Native platform packages inherit the checked wrapper's shipped licence.
  let licencePath = path;
  if (pkg.name.startsWith('@esbuild/'))
    licencePath = path.includes('node_modules/tsx/')
      ? 'node_modules/tsx/node_modules/esbuild'
      : 'node_modules/esbuild';
  if (pkg.name.startsWith('@rollup/rollup-')) licencePath = 'node_modules/rollup';
  if (pkg.name.startsWith('@biomejs/cli-')) licencePath = 'node_modules/@biomejs/biome';
  const files = await readdir(licencePath);
  if (!files.some((name) => /^(licen[cs]e|copying)([-._]|$)/i.test(name)))
    violations.push(`${pkg.name}: missing shipped licence file`);
  installed++;
  rows.push({ name: pkg.name, version: pkg.version, license, installed: true });
}
// Fonts are vendored assets, not npm dependencies: IBM Plex latin woff2 files
// from @fontsource 5.3.0 under the SIL Open Font License 1.1, served from
// public/fonts with the licence beside them.
const fonts = {
  'ibm-plex-sans': ['latin-400-normal', 'latin-400-italic', 'latin-500-normal', 'latin-600-normal'],
  'ibm-plex-mono': ['latin-400-normal', 'latin-600-normal'],
  'ibm-plex-sans-condensed': ['latin-500-normal', 'latin-600-normal'],
};
const ofl = await readFile('public/fonts/OFL.txt', 'utf8').catch(() => '');
let vendored = 0;
for (const [family, styles] of Object.entries(fonts)) {
  const files = styles.map((style) => `${family}-${style}.woff2`);
  let bytes = 0;
  for (const file of files) {
    const info = await stat(`public/fonts/${file}`).catch(() => undefined);
    if (info) bytes += info.size;
    else violations.push(`public/fonts/${file}: missing vendored font`);
  }
  if (
    !ofl.includes(`@fontsource/${family} 5.3.0`) ||
    !ofl.includes('SIL Open Font License, Version 1.1')
  )
    violations.push(`@fontsource/${family}: OFL 1.1 notice missing from public/fonts/OFL.txt`);
  vendored++;
  rows.push({
    name: `@fontsource/${family}`,
    version: '5.3.0',
    license: 'OFL-1.1',
    vendored: 'public/fonts',
    files,
    bytes,
    source: `https://registry.npmjs.org/@fontsource/${family}/-/${family}-5.3.0.tgz`,
  });
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  await writeFile(
    'docs/dependency-licenses.json',
    `${JSON.stringify(
      rows.sort((a, b) => a.name.localeCompare(b.name)),
      null,
      2,
    )}\n`,
  );
  console.log(
    `${rows.length - vendored} resolved packages licence-checked; ${installed} installed packages also checked against shipped licence files; ${vendored} vendored IBM Plex font packages (OFL-1.1) checked against public/fonts/OFL.txt. All permitted. Inventory: docs/dependency-licenses.json`,
  );
}
