#!/usr/bin/env node
// Safety scan for anything that leaves this machine (npm packages, public and private repos, the site, the docs).
// Fails on: wallet addresses other than the well-known development accounts, miner session endpoints, session and
// channel ids, transaction or block hashes, secrets and key material, internal file names, personal names, email
// addresses other than the brand address, local paths, and the wording rules of the public text check.
//
//   node scan.mjs [--report] [--profile public|private] [--allow-file F] <file or dir>...
//
// Private inputs, never written into a repository (each optional):
//   SCAN_FORBIDDEN_WORDS   comma or newline separated words (personal names, handles); or ~/.config/floprouter/forbidden-words
//   SCAN_DENY_HOSTS        miner endpoint hosts to refuse; or ~/.config/floprouter/deny-hosts
//   SCAN_INTERNAL_NAMES    names of internal documents and files; or ~/.config/floprouter/internal-names
//   SCAN_WORDING           extra words the public text must not contain; or ~/.config/floprouter/wording
// --allow-file: tokens allowed in this tree (one per line: public chain constants such as a genesis hash or a model
// hash). Lines starting with # are comments. scan-allow.txt next to the scanned root is read automatically.
// --profile private (the private platform repository) skips the publication rules: chain data (addresses, ids, hashes,
// miner hosts), internal file names and wording. Secrets, keys, mnemonics, personal names, emails and local paths are
// refused in every profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const report = args.includes('--report');
const mintignore = args.includes('--exclude-mintignore');   // skip what .mintignore keeps out of the published docs
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'public';
const allowFiles = [];
// --lib-constants <dir,dir>: values that appear literally in these library sources (for example @polkadot, @noble)
// are library constants (curve parameters, wasm blobs), allowed only inside bundled chunks. Our own code's data is not
// in those libraries, so it is still caught, in bundles too.
const libDirs = [];
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report' || args[i] === '--exclude-mintignore') continue;
  if (args[i] === '--profile') { i++; continue; }
  if (args[i] === '--allow-file') { allowFiles.push(args[++i]); continue; }
  if (args[i] === '--lib-constants') { libDirs.push(...args[++i].split(',').filter(Boolean)); continue; }
  targets.push(args[i]);
}
if (!targets.length) { console.error('usage: scan.mjs [--report] [--profile public|private] [--allow-file F] <path>...'); process.exit(2); }

const list = (s) => String(s ?? '').split(/[\n,]/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
const readList = (envName, file) => {
  if (process.env[envName]) return list(process.env[envName]);
  const f = path.join(os.homedir(), '.config', 'floprouter', file);
  try { return list(fs.readFileSync(f, 'utf8')); } catch { return []; }
};
const words = readList('SCAN_FORBIDDEN_WORDS', 'forbidden-words');
const denyHosts = readList('SCAN_DENY_HOSTS', 'deny-hosts').map((h) => h.toLowerCase());
const internalNames = readList('SCAN_INTERNAL_NAMES', 'internal-names');
const wording = readList('SCAN_WORDING', 'wording');
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Well-known development accounts (the standard //Alice ... //Ferdie keys): safe to show in examples.
const DEV_ADDRESSES = new Set([
  '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
  '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y', '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy',
  '5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw', '5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL',
]);
const allowed = new Set();
for (const t of targets) { const f = path.join(fs.statSync(t).isDirectory() ? t : path.dirname(t), 'scan-allow.txt'); if (fs.existsSync(f)) allowFiles.push(f); }
for (const f of allowFiles) for (const x of list(fs.readFileSync(f, 'utf8'))) allowed.add(x.split(/\s/)[0]);

const BRAND_EMAILS = new Set(['admin@floprouter.com']);
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'when', 'from', 'into', 'not', 'are', 'has', 'its', 'then', 'than', 'this', 'test', 'was', 'but', 'you', 'your', 'one', 'all', 'any', 'can', 'out', 'per', 'via', 'only', 'does', 'have', 'after', 'before', 'without']);
const rules = [
  { id: 'wallet-address', profiles: ['public'], re: /(?<![1-9A-HJ-NP-Za-km-z])5[1-9A-HJ-NP-Za-km-z]{46,47}(?![1-9A-HJ-NP-Za-km-z])/g, ok: (m) => DEV_ADDRESSES.has(m) || allowed.has(m) },
  { id: 'hash-or-channel-id', profiles: ['public'], re: /\b0x[0-9a-fA-F]{64}\b/g, ok: (m) => allowed.has(m.toLowerCase()) || allowed.has(m) || /^0x(0{64}|f{64})$/i.test(m) },
  { id: 'session-id', profiles: ['public'], re: /\bgen-[0-9a-z]{8}-[0-9a-f]{12}\b/g, ok: (m) => allowed.has(m) },
  // Obvious placeholders (all one digit apart from the last) are allowed; real ids are random hex.
  { id: 'withdrawal-or-key-id', profiles: ['public'], re: /\b(wd-[0-9a-f]{16}|key_[0-9a-f]{12})\b/g, ok: (m) => allowed.has(m) || /^(wd-|key_)(.)\2+.?$/.test(m) },
  { id: 'api-key', re: /\bfr_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g },
  { id: 'key-material', re: /"encoded"\s*:\s*"[A-Za-z0-9+/=]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,})\b/g },
  // A quoted or standalone run of exactly 12 or 24 lowercase words without the small words of ordinary prose.
  { id: 'mnemonic', re: /(^|['"`])\s*(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\s*(['"`]|$)/gm,
    ok: (m) => { const w = m.replace(/['"`]/g, '').trim().split(/\s+/); return ![12, 24].includes(w.length) || new Set(w).size !== w.length || w.some((x) => STOP.has(x)); } },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    vendorOk: true,
    ok: (m) => BRAND_EMAILS.has(m.toLowerCase()) || /[@.](example|exemple|exemplo|ejemplo|beispiel)\.(com|org|net)$|\.(test|example|invalid|localhost)$/i.test(m) || /@(polkadot|modelcontextprotocol|ai-sdk|types|scalar|fontsource-variable|fontsource|opennextjs|tailwindcss|orama|langchain|noble|scure|vercel|next|babel|esbuild|swc|img|ui|radix-ui|floating-ui|shikijs|mdx-js)\b/.test(m) || /\.(png|svg|jpe?g|webp|gif|woff2?)$/i.test(m) },
  { id: 'local-path', vendorOk: true, re: /\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9_-]*\/|[A-Z]:\\Users\\|\/Applications\/MAMP|\/private\/tmp\/|\/var\/folders\//g, ok: (m) => /\/home\/(runner|user|username|you)\/|\/Users\/(you|user|username|name)$/.test(m) },
  { id: 'internal-file', re: new RegExp(`\\b(docs\\/internal|keys\\/[a-z0-9_-]+\\.(json|seed|apikey|address)${internalNames.length ? '|' + internalNames.map(esc).join('|') : ''})\\b`, 'g'), profiles: ['public'] },
];
if (wording.length) rules.push({ id: 'wording', re: new RegExp(wording.map(esc).join('|'), 'gi'), ok: (m, line) => /@ai-sdk\/openai-compatible|createOpenAICompatible/.test(line), profiles: ['public'] });
if (words.length) rules.push({ id: 'personal-name', re: new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi') });
if (denyHosts.length) rules.push({ id: 'miner-endpoint', profiles: ['public'], re: new RegExp(`(?<![A-Za-z0-9.-])(${denyHosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9-])`, 'gi') });

const VENDOR = /(^|\/)(_next\/static\/chunks|vendor|vendors)\//;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.open-next', '.wrangler', '.turbo', '.cache']);
const SKIP_FILES = /(^|\/)(package-lock\.json|scan-allow\.txt)$|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp4|webm|sqlite)$/i;
const files = [];
const walk = (p) => {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (skipPath(p)) return;
  if (st.isDirectory()) { if (!SKIP_DIRS.has(path.basename(p))) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
  if (!SKIP_FILES.test(p) && st.size < 8 * 1024 * 1024) files.push(p);
};
const ignored = [];
if (mintignore) for (const t of targets) {
  const f = path.join(t, '.mintignore');
  if (fs.existsSync(f)) for (const l of list(fs.readFileSync(f, 'utf8'))) ignored.push(path.join(t, l.replace(/\/$/, '')));
}
const skipPath = (p) => ignored.some((x) => p === x || p.startsWith(x + path.sep)) || p.split(path.sep).includes('.github');
const walk0 = walk;
for (const t of targets) walk0(t);

const libTokens = new Set();
if (libDirs.length) {
  const pats = [/(?<![1-9A-HJ-NP-Za-km-z])5[1-9A-HJ-NP-Za-km-z]{46,47}(?![1-9A-HJ-NP-Za-km-z])/g, /\b0x[0-9a-fA-F]{64}\b/g];
  const libWalk = (p) => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) libWalk(path.join(p, e)); return; }
    if (!/\.(c?js|mjs)$/.test(p) || st.size > 16 * 1024 * 1024) return;
    const t = fs.readFileSync(p, 'utf8');
    for (const re of pats) { re.lastIndex = 0; let m; while ((m = re.exec(t))) libTokens.add(m[0].toLowerCase()); }
  };
  for (const d of libDirs) libWalk(d);
}
const BUNDLE = /(^|\/)_next\/static\/chunks\/[^/]+\.js$/;
const findings = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) continue;                         // binary
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  for (const r of rules) {
    if (r.profiles && !r.profiles.includes(profile)) continue;
    if (r.vendorOk && VENDOR.test(f)) continue;
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(text))) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      const line = lines[lineNo - 1] ?? '';
      if (r.ok && r.ok(m[0], line)) continue;
      if (libTokens.size && BUNDLE.test(f) && (r.id === 'wallet-address' || r.id === 'hash-or-channel-id') && libTokens.has(m[0].toLowerCase())) continue;
      findings.push({ rule: r.id, file: f, line: lineNo, match: r.id === 'personal-name' || r.id === 'api-key' || r.id === 'key-material' ? '[redacted]' : m[0].slice(0, 70) });
    }
  }
}
const byRule = {};
for (const x of findings) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
for (const x of findings.slice(0, 200)) console.log(`${x.rule}\t${x.file}:${x.line}\t${x.match}`);
if (findings.length > 200) console.log(`... ${findings.length - 200} more`);
console.log(`safety scan (${profile}): ${files.length} files, ${findings.length} findings${findings.length ? ' ' + JSON.stringify(byRule) : ''}${words.length ? '' : ' (no private word list loaded)'}${denyHosts.length ? '' : ' (no miner host list loaded)'}`);
process.exit(findings.length && !report ? 1 : 0);
