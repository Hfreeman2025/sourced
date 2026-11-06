export interface LockEntry {
  os?: string[];
  cpu?: string[];
  optionalDependencies?: Record<string, string>;
}
export interface InstalledPackage {
  name: string;
  license: string | undefined;
  hasLicenceFile: boolean;
}
export type Verdict =
  | { ok: true; inheritedFrom?: string; reason?: string }
  | { ok: false; reason: string };
export const approvedLicences: Set<string>;
export function platformParent(
  lockPackages: Record<string, LockEntry>,
  path: string,
): string | undefined;
export function licenceVerdict(
  lockPackages: Record<string, LockEntry>,
  path: string,
  installed: (path: string) => InstalledPackage | undefined,
): Verdict;
