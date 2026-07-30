// Extracts one release's section out of CHANGELOG.md, and doubles as the
// release workflow's consistency gate. See CLAUDE.md "Versioning".
//
// As a module: changelogSection(version) → the section text, or null.
//   Used by scripts/release.mjs to refuse a release whose notes are unwritten.
//
// As a command: node scripts/release-notes.mjs v0.9.1
//   Verifies that the tag, package.json, src/version.js and CHANGELOG.md all
//   name the same version, then prints the section on stdout — which
//   .github/workflows/release.yml captures as the GitHub release body. Exits
//   non-zero on any disagreement, so a half-prepared release fails before it
//   publishes anything.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The heading the release flow requires: "## [0.9.1] - 2026-07-30". The date is
// mandatory so an entry cannot be left as a placeholder.
export function changelogSection(version, file = 'CHANGELOG.md') {
  const esc = version.replace(/\./g, '\\.');
  const re = new RegExp(`^## \\[${esc}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  const text = readFileSync(file, 'utf8');
  const start = text.search(re);
  if (start < 0) return null;
  const body = text.slice(start);
  const end = body.indexOf('\n## ', 1);          // up to the next release heading
  const section = (end < 0 ? body : body.slice(0, end)).trim();
  // Drop the heading itself — the GitHub release already carries the version as
  // its title, so repeating it in the body reads as a duplicate.
  return section.replace(re, '').trim();
}

function versionIn(file) {
  const m = readFileSync(file, 'utf8').match(/VERSION = '([^']*)'/);
  return m && m[1];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const tag = process.argv[2];
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error('usage: node scripts/release-notes.mjs vX.Y.Z');
    process.exit(1);
  }
  const version = tag.slice(1);
  const fail = msg => { console.error(`::error::${msg}`); process.exit(1); };

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (pkg !== version) fail(`tag ${tag} does not match package.json version ${pkg}`);

  const src = versionIn('src/version.js');
  if (src !== version) fail(`tag ${tag} does not match src/version.js VERSION ${src}`);

  const section = changelogSection(version);
  if (!section) fail(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);

  process.stdout.write(section + '\n');
}
