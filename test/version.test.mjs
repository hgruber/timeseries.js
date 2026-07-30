// The version number used to be a build counter bumped by a git hook; it is now
// a semver signal that consumers pin against, set only by scripts/release.mjs.
// Nothing enforces the package.json ↔ src/version.js mirror at commit time any
// more, so it is asserted here — a drift would ship a bundle whose
// TimeSeries.VERSION contradicts the npm version it was installed as.
//
// Also covers changelogSection(), which both scripts/release.mjs and the release
// workflow depend on: if it silently returned the wrong slice, a release would
// publish with someone else's notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDOM } from './helpers/dom.mjs';
import { changelogSection } from '../scripts/release-notes.mjs';

installDOM();

const mod = await import('../src/timeseries.js');
const TimeSeries = mod.default;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('package.json carries a plain semver version', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/,
    'a release version carries no prerelease or build suffix — BUILD holds that');
});

test('src/version.js mirrors package.json exactly', () => {
  assert.equal(TimeSeries.VERSION, pkg.version);
});

test('BUILD is a string safe to append to the version', () => {
  // Empty in a published bundle, the short SHA on a Pages deploy, 'dev' in the
  // repo. versionTag() concatenates it, so anything else would end up drawn.
  assert.equal(typeof TimeSeries.BUILD, 'string');
  assert.match(TimeSeries.BUILD, /^[A-Za-z0-9.-]*$/);
});

// ── changelogSection() ────────────────────────────────────────────────────────

const fixture = (text) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ts-changelog-')), 'CHANGELOG.md');
  writeFileSync(file, text);
  return file;
};

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.9.1] - 2026-08-01

### Fixed

- The thing.

## [0.9.0] - 2026-07-30

First release.
`;

test('changelogSection returns one release, stopping at the next heading', () => {
  const file = fixture(CHANGELOG);
  assert.equal(changelogSection('0.9.1', file), '### Fixed\n\n- The thing.');
  assert.equal(changelogSection('0.9.0', file), 'First release.');
});

test('changelogSection returns null for an unwritten or undated entry', () => {
  assert.equal(changelogSection('0.9.2', fixture(CHANGELOG)), null);
  // A heading without a date is a placeholder, not a release.
  assert.equal(changelogSection('0.9.2', fixture('## [0.9.2]\n\nnotes\n')), null);
});

test('the shipped CHANGELOG has a dated section for every released version', () => {
  const text = readFileSync('CHANGELOG.md', 'utf8');
  for (const m of text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) {
    assert.ok(changelogSection(m[1]), `CHANGELOG.md section for ${m[1]} is missing its date`);
  }
});
