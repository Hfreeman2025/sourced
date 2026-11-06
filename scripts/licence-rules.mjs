// The dependency licence rules, kept free of file access so they can be tested.

/** Licences a dependency may use. */
export const approvedLicences = new Set([
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

const MARKER = 'node_modules/';

/** The lockfile path of the package that installs a platform-specific binary as
 * one of its optional dependencies, looked up the way Node resolves packages: at
 * the binary's own node_modules level first, then each level above. */
export function platformParent(lockPackages, path) {
  const info = lockPackages[path];
  if (!info || (!info.os && !info.cpu)) return undefined;
  const at = path.lastIndexOf(MARKER);
  const name = path.slice(at + MARKER.length);
  const levels = [];
  for (let i = path.indexOf(MARKER); i !== -1 && i < at; i = path.indexOf(MARKER, i + 1))
    levels.unshift(path.slice(0, i));
  levels.unshift(path.slice(0, at));
  for (const level of [...new Set(levels)]) {
    const parent = Object.entries(lockPackages).find(([candidate, entry]) => {
      if (!candidate.startsWith(level + MARKER)) return false;
      if (candidate.slice((level + MARKER).length).includes(MARKER)) return false;
      return Object.hasOwn(entry?.optionalDependencies ?? {}, name);
    });
    if (parent) return parent[0];
  }
  return undefined;
}

/**
 * Whether an installed package satisfies the gate.
 *
 * A package must declare an approved licence and ship a licence file. The one
 * exception is a platform-specific binary (esbuild, Rollup and Biome publish one
 * per operating system) that ships no licence file of its own: it may rely on its
 * parent's, but only when the parent is installed, ships a licence file, declares
 * an approved licence, and the binary declares exactly the same licence.
 *
 * `installed(path)` returns `{ name, license, hasLicenceFile }` for an installed
 * package, or undefined.
 */
export function licenceVerdict(lockPackages, path, installed) {
  const own = installed(path);
  if (!own) return { ok: false, reason: `${path}: not installed` };
  if (!approvedLicences.has(own.license))
    return { ok: false, reason: `${own.name}: ${own.license ?? 'UNKNOWN'}` };
  if (own.hasLicenceFile) return { ok: true };
  const parentPath = platformParent(lockPackages, path);
  const parent = parentPath ? installed(parentPath) : undefined;
  if (!parent) return { ok: false, reason: `${own.name}: missing shipped licence file` };
  if (!parent.hasLicenceFile || !approvedLicences.has(parent.license))
    return {
      ok: false,
      reason: `${own.name}: missing shipped licence file, and its parent ${parent.name} is not an approved, licensed package`,
    };
  if (parent.license !== own.license)
    return {
      ok: false,
      reason: `${own.name}: declares ${own.license}, but its parent ${parent.name} is ${parent.license}`,
    };
  return {
    ok: true,
    inheritedFrom: parent.name,
    reason: `Platform-specific binary installed by ${parent.name}; it ships no licence file, declares the same licence (${own.license}), and ${parent.name} ships the licence text.`,
  };
}
