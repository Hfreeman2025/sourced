import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { approvedLicences, licenceVerdict } from './licence-rules.mjs';
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
// Read every installed package once; the verdicts below may consult a parent.
const installedPackages = new Map();
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path) continue;
  if (!record(info)) throw new Error(`Invalid lockfile entry: ${path}`);
  let pkg;
  try {
    pkg = jsonRecord(await readFile(join(path, 'package.json'), 'utf8'), path);
  } catch (error) {
    // Optional platform binaries for other systems are in the lockfile but not installed.
    if (error.code === 'ENOENT' && info.optional === true) continue;
    throw error;
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string')
    throw new Error(`Invalid package identity in ${path}`);
  const license =
    typeof pkg.license === 'string'
      ? pkg.license
      : record(pkg.license)
        ? pkg.license.type
        : undefined;
  const files = await readdir(path);
  installedPackages.set(path, {
    name: pkg.name,
    version: pkg.version,
    license,
    hasLicenceFile: files.some((name) => /^(licen[cs]e|copying)([-._]|$)/i.test(name)),
  });
}
let installed = 0;
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path) continue;
  const name = path.split('node_modules/').at(-1);
  const pkg = installedPackages.get(path);
  if (!pkg) {
    // Not installed here: the lockfile's declared licence must still be approved.
    if (typeof info.license !== 'string' || !approvedLicences.has(info.license))
      violations.push(
        `${name}: unapproved optional dependency licence ${info.license ?? 'UNKNOWN'}`,
      );
    rows.push({ name, version: info.version, license: info.license, installed: false });
    continue;
  }
  const verdict = licenceVerdict(lock.packages, path, (at) => installedPackages.get(at));
  if (!verdict.ok) violations.push(verdict.reason);
  installed++;
  rows.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    installed: true,
    ...(verdict.ok && verdict.inheritedFrom
      ? { licenceText: `inherited from ${verdict.inheritedFrom}`, reason: verdict.reason }
      : {}),
  });
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
