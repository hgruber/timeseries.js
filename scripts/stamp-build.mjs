// Sets BUILD in src/version.js, which the canvas version watermark appends to
// VERSION. Called only from CI (see .github/workflows/) — the Pages deploy
// stamps the short commit SHA so a deployed demo names its exact build, the
// release workflow stamps '' so the published bundle reads as a plain version.
// The change is never committed; it only touches the CI working tree.
//
//   node scripts/stamp-build.mjs g1a2b3c4   →  export const BUILD = 'g1a2b3c4';
//   node scripts/stamp-build.mjs ''         →  export const BUILD = '';
import { readFileSync, writeFileSync } from 'node:fs';

const build = process.argv[2];
if (build === undefined) {
  console.error('usage: node scripts/stamp-build.mjs <build-id|"">');
  process.exit(1);
}
if (!/^[A-Za-z0-9.-]*$/.test(build)) {
  console.error(`refusing to stamp ${JSON.stringify(build)}: build ids are [A-Za-z0-9.-]`);
  process.exit(1);
}

const file = 'src/version.js';
const src = readFileSync(file, 'utf8');
const stamped = src.replace(/BUILD = '[^']*'/, `BUILD = '${build}'`);
if (stamped === src && !src.includes(`BUILD = '${build}'`)) {
  console.error(`${file}: no BUILD assignment found to stamp`);
  process.exit(1);
}
writeFileSync(file, stamped);

console.log(`build stamped as ${build === '' ? '(empty)' : build}`);
