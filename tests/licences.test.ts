import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type InstalledPackage,
  licenceVerdict,
  platformParent,
} from '../scripts/licence-rules.mjs';

const linux = { os: ['linux'], cpu: ['x64'] };
const lock = {
  'node_modules/rollup': { optionalDependencies: { '@napi-rs/lzma-linux-x64-gnu': '1.4.5' } },
  'node_modules/@napi-rs/lzma-linux-x64-gnu': { ...linux, optional: true },
  'node_modules/esbuild': { optionalDependencies: { '@esbuild/linux-x64': '0.27.0' } },
  'node_modules/@esbuild/linux-x64': linux,
  'node_modules/tsx/node_modules/esbuild': {
    optionalDependencies: { '@esbuild/linux-x64': '0.25.0' },
  },
  'node_modules/tsx/node_modules/@esbuild/linux-x64': linux,
  'node_modules/unclaimed-binary': linux,
  'node_modules/plain': {},
};
const pkg = (name: string, license: string, hasLicenceFile: boolean): InstalledPackage => ({
  name,
  license,
  hasLicenceFile,
});

test('a platform binary without a licence file inherits its approved parent’s licence', () => {
  const installed = new Map([
    ['node_modules/rollup', pkg('rollup', 'MIT', true)],
    ['node_modules/@napi-rs/lzma-linux-x64-gnu', pkg('@napi-rs/lzma-linux-x64-gnu', 'MIT', false)],
  ]);
  const verdict = licenceVerdict(lock, 'node_modules/@napi-rs/lzma-linux-x64-gnu', (at) =>
    installed.get(at),
  );
  assert.equal(verdict.ok, true);
  assert.ok(verdict.ok && verdict.inheritedFrom === 'rollup');
  assert.match(
    verdict.ok ? (verdict.reason ?? '') : '',
    /installed by rollup.*same licence \(MIT\)/,
  );
});

test('a binary resolves to the parent at its own level before any parent above it', () => {
  assert.equal(
    platformParent(lock, 'node_modules/tsx/node_modules/@esbuild/linux-x64'),
    'node_modules/tsx/node_modules/esbuild',
  );
  assert.equal(platformParent(lock, 'node_modules/@esbuild/linux-x64'), 'node_modules/esbuild');
});

test('the exception refuses every case it must not cover', () => {
  const verdict = (path: string, entries: [string, InstalledPackage][]) =>
    licenceVerdict(lock, path, (at) => new Map(entries).get(at));
  const binary = 'node_modules/@napi-rs/lzma-linux-x64-gnu';
  const cases: [string, ReturnType<typeof verdict>, RegExp][] = [
    [
      'a binary declaring a different licence from its parent',
      verdict(binary, [
        ['node_modules/rollup', pkg('rollup', 'MIT', true)],
        [binary, pkg('@napi-rs/lzma-linux-x64-gnu', 'Apache-2.0', false)],
      ]),
      /declares Apache-2.0, but its parent rollup is MIT/,
    ],
    [
      'a parent with an unapproved licence',
      verdict(binary, [
        ['node_modules/rollup', pkg('rollup', 'GPL-3.0', true)],
        [binary, pkg('@napi-rs/lzma-linux-x64-gnu', 'MIT', false)],
      ]),
      /parent rollup is not an approved, licensed package/,
    ],
    [
      'a parent that ships no licence file either',
      verdict(binary, [
        ['node_modules/rollup', pkg('rollup', 'MIT', false)],
        [binary, pkg('@napi-rs/lzma-linux-x64-gnu', 'MIT', false)],
      ]),
      /parent rollup is not an approved, licensed package/,
    ],
    [
      'a platform binary that no installed package claims',
      verdict('node_modules/unclaimed-binary', [
        ['node_modules/unclaimed-binary', pkg('unclaimed-binary', 'MIT', false)],
      ]),
      /unclaimed-binary: missing shipped licence file/,
    ],
    [
      'an ordinary package without a licence file',
      verdict('node_modules/plain', [['node_modules/plain', pkg('plain', 'MIT', false)]]),
      /plain: missing shipped licence file/,
    ],
    [
      'a binary whose own licence is unapproved',
      verdict(binary, [
        ['node_modules/rollup', pkg('rollup', 'MIT', true)],
        [binary, pkg('@napi-rs/lzma-linux-x64-gnu', 'GPL-3.0', false)],
      ]),
      /@napi-rs\/lzma-linux-x64-gnu: GPL-3.0/,
    ],
  ];
  for (const [label, result, reason] of cases) {
    assert.equal(result.ok, false, label);
    assert.match(result.ok ? '' : result.reason, reason, label);
  }
  // A package with its own licence file and an approved licence needs no exception.
  const own = verdict('node_modules/plain', [['node_modules/plain', pkg('plain', 'MIT', true)]]);
  assert.deepEqual(own, { ok: true });
});
