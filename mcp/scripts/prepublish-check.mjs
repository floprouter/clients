#!/usr/bin/env node
// Runs before `npm publish` (prepublishOnly). Refuses to publish when the package would carry personal data, local
// paths, secrets or stray files, or when its code does not parse or its tests fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 1. package.json metadata
if (pkg.author !== 'floprouter') problems.push(`author must be "floprouter" (is ${JSON.stringify(pkg.author)})`);
for (const k of ['contributors', 'maintainers']) if (pkg[k] !== undefined) problems.push(`package.json must not carry "${k}"`);
if (!pkg.repository || pkg.repository.url !== 'git+https://github.com/floprouter/clients.git') problems.push('package.json repository must be git+https://github.com/floprouter/clients.git (npm provenance checks it)');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) problems.push(`version ${pkg.version} is not semver`);
for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
  if (/^(file:|link:|\.|\/|git|https?:)/.test(String(spec))) problems.push(`dependency ${name} points at ${spec}, not a registry version`);
}
const meta = JSON.stringify({ d: pkg.description, k: pkg.keywords, h: pkg.homepage });
if (!fs.existsSync(path.join(root, 'LICENSE'))) problems.push('no LICENSE file: the owner has to choose the licence before publishing');

// 2. what npm would pack
const packed = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
const files = packed.files.map((f) => f.path);
const allowed = /^(package\.json|README\.md|LICENSE|bin\/[^/]+\.js|src\/[^/]+\.js)$/;
for (const f of files) if (!allowed.test(f)) problems.push(`stray file in the package: ${f}`);

// 3. content of every packed file
const patterns = [
  [/\/Users\/[^/\s'"`]+|\/home\/[a-z][^/\s'"`]*|[A-Z]:\\\\Users\\\\|\/Applications\/MAMP/, 'a local path'],
  [/[A-Za-z0-9._%+-]+@(?!noreply\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/, 'an email address'],
  [/fr_[A-Za-z0-9_-]{30,}/, 'an API key'],
  [/"encoded"\s*:\s*"|BEGIN [A-Z ]*PRIVATE KEY/, 'key material'],
  [/^\s*(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\s*$|['"`](?:[a-z]{3,8} ){11,23}[a-z]{3,8}['"`]/m, 'something that looks like a mnemonic'],
];
for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  for (const [re, what] of patterns) {
    const m = re.exec(text);
    if (m && !(what === 'an email address' && /@(polkadot|modelcontextprotocol|ai-sdk)\//.test(m[0]))) problems.push(`${f} contains ${what}: ${m[0].slice(0, 40)}`);
  }
}

// 4. code parses; tests pass
for (const f of files.filter((x) => x.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }); } catch (e) { problems.push(`${f} does not parse: ${String(e.stderr).split('\n')[0]}`); }
}
if (pkg.scripts?.test) {
  try { execFileSync(npm, ['test', '--silent'], { cwd: root, stdio: 'pipe' }); } catch (e) { problems.push(`npm test failed: ${String(e.stdout ?? '').slice(-300)}${String(e.stderr ?? '').slice(-300)}`); }
}

if (problems.length) {
  console.error(`prepublish check failed for ${pkg.name}@${pkg.version}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`prepublish check passed for ${pkg.name}@${pkg.version}: ${files.length} files, ${packed.size} bytes packed`);
