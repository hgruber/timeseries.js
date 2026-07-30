// Cuts a release: validates, sets the version in package.json and
// src/version.js together, commits and tags. Pushes nothing — a mistake stays
// local and fixable until you push. See CLAUDE.md "Versioning".
//
//   npm run release -- 0.9.1
//
// Every check runs *before* the first write, so a rejected release leaves the
// working tree exactly as it was.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changelogSection } from './release-notes.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });
const die = msg => { console.error(`release: ${msg}`); process.exit(1); };

const version = process.argv[2];

// ── 1. The argument is a plain semver version, ahead of the current one ───────
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  die('usage: npm run release -- X.Y.Z  (plain semver, no prefix, no suffix)');
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const parse = v => v.split('.').map(Number);
const [cur, next] = [parse(pkg.version), parse(version)];
if (next.join('.') === cur.join('.')) die(`${version} is already the current version`);
for (let i = 0; i < 3; i++) {
  if (next[i] > cur[i]) break;
  if (next[i] < cur[i]) die(`${version} is behind the current version ${pkg.version}`);
}

// ── 2. Clean tree, on main, tag free ─────────────────────────────────────────
if (git('status', '--porcelain')) die('working tree is not clean — commit or stash first');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') die(`on branch ${branch}, releases are cut from main`);
const tag = `v${version}`;
if (git('tag', '--list', tag)) die(`tag ${tag} already exists`);

// ── 3. The changelog entry exists *before* the tag, not after ────────────────
// The release workflow re-checks this on the tag and uses the same section as the
// GitHub release body, so a missing entry would otherwise fail the release only
// after pushing — checking here keeps the failure local.
if (!changelogSection(version)) {
  die(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section — write the notes first`);
}

// ── 4. Green ─────────────────────────────────────────────────────────────────
run('npm', 'test');
run('npm', 'run', 'lint:strict');

// ── 5. Write both files. package.json is the source of truth, src/version.js
//      mirrors it; a test asserts they agree, so they move together or not at all.
pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const versionFile = 'src/version.js';
const src = readFileSync(versionFile, 'utf8');
writeFileSync(versionFile, src.replace(/VERSION = '[^']*'/, `VERSION = '${version}'`));

// ── 6. Commit and tag ────────────────────────────────────────────────────────
run('git', 'add', 'package.json', versionFile);
run('git', 'commit', '-m', `Release ${version}`);
run('git', 'tag', '-a', tag, '-m', `timeseries.js ${version}`);

console.log(`
${tag} is committed and tagged locally. Nothing has been pushed.

  git push && git push origin ${tag}

pushing the tag triggers .github/workflows/release.yml, which publishes to npm
and creates the GitHub release.`);
