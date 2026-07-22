// Bumps the patch component of package.json's version and mirrors it into
// src/version.js. Invoked by hooks/pre-commit on every commit — see
// CLAUDE.md "Versioning". Not meant to be run standalone outside that hook.
import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const parts = pkg.version.split('.').map(Number);
parts[2] += 1;
pkg.version = parts.join('.');
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const versionFile = 'src/version.js';
const src = readFileSync(versionFile, 'utf8');
writeFileSync(versionFile, src.replace(/VERSION = '[^']*'/, `VERSION = '${pkg.version}'`));

console.log(`version bumped to ${pkg.version}`);
