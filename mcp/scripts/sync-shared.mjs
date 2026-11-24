#!/usr/bin/env node
// The grant renewal code is one module shared with the CLI: clients/cli/src/{renewal,wallet,io}.js are the source of
// truth and this package carries byte-for-byte copies. `npm run sync-shared` copies them; `--check` (run by the tests
// and the prepublish check) fails when a copy differs from the CLI's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.resolve(here, '..', 'cli', 'src');
const FILES = ['renewal.js', 'wallet.js', 'io.js'];
const check = process.argv.includes('--check');
if (!fs.existsSync(cli)) { console.log('sync-shared: no ../cli/src next to this package; nothing to compare'); process.exit(0); }
const differ = [];
for (const f of FILES) {
  const src = fs.readFileSync(path.join(cli, f)); const dst = path.join(here, 'src', f);
  if (fs.existsSync(dst) && fs.readFileSync(dst).equals(src)) continue;
  if (check) differ.push(f); else { fs.writeFileSync(dst, src); console.log(`copied cli/src/${f}`); }
}
if (differ.length) { console.error(`sync-shared: mcp/src differs from cli/src for ${differ.join(', ')}: run npm run sync-shared`); process.exit(1); }
if (check) console.log('sync-shared: shared modules match the CLI');
