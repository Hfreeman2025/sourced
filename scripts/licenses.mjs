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
    `${rows.length} resolved packages licence-checked; ${installed} installed packages also checked against shipped licence files. All permitted. Inventory: docs/dependency-licenses.json`,
  );
}
