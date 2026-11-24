// Terminal helpers: config file, prompts (with hidden input), tables, number formatting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
export const dim = c(2);
export const bold = c(1);
export const green = c(32);
export const red = c(31);
export const yellow = c(33);
export const err = (s) => process.stderr.write(s + '\n');

// ---- config file -------------------------------------------------------------------------------------------------
// One JSON file, mode 600: { base_url, api_key, address }. Only the router API key is stored, never wallet material.
export function configPath() {
  if (process.env.FLOPROUTER_CONFIG) return process.env.FLOPROUTER_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'floprouter', 'config.json');
}

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

export function writeConfig(patch) {
  const file = configPath();
  const next = { ...readConfig(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

// ---- prompts -----------------------------------------------------------------------------------------------------
export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

/** Reads one line without echoing it. Refuses to run without a terminal, so a secret is never read from a pipe by accident. */
export function askHidden(question) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('no terminal to prompt on: use --seed-file or --key-file'));
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (fn) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); fn(); };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question, { yes } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('confirmation needed but there is no terminal: re-run with --yes after reading the summary above');
  const a = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

// ---- output ------------------------------------------------------------------------------------------------------
export function table(rows, columns) {
  const cells = rows.map((r) => columns.map((col) => (r[col.key] === null || r[col.key] === undefined ? '-' : String(r[col.key]))));
  const widths = columns.map((col, i) => Math.max(col.title.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => (columns[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [bold(line(columns.map((c2) => c2.title))), ...cells.map(line)].join('\n');
}

export const pct = (x) => (x === null || x === undefined ? null : `${(x * 100).toFixed(1)}%`);
export const short = (a, n = 6) => (a && a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
export function flopAmount(s) {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return String(s);
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return String(Number(n.toPrecision(6)));
}
export const printJson = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
