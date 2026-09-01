// The released semver version. Do not hand-edit — `npm run release -- X.Y.Z`
// sets it here and in package.json together. See CLAUDE.md "Versioning".
export const VERSION = '0.10.4';

// Build identity, separate from the version on purpose: VERSION only moves at a
// release, so between releases it cannot say *which* build you are looking at.
// 'dev' in the repo; scripts/stamp-build.mjs overwrites it in CI — the Pages
// deploy stamps the short commit SHA, the release workflow clears it, since a
// published tarball *is* an exact version. Never committed with a CI value.
export const BUILD = 'dev';
