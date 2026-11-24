// Keep the grant alive from an agent loop or framework (no SDK): call this once an hour, or before a batch of work.
// It runs the CLI's `grant --auto-renew`, which renews only when needed and signs with the agent's own key file.
//   FLOPROUTER_API_KEY=fr_... FLOPROUTER_KEY_FILE=./wallet.json node keep_grant_alive.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Returns {action: 'skip' | 'wait' | 'renew' | 'grant', reason, tx?}. Throws when the CLI fails or refuses. */
export async function keepGrantAlive({ renewBefore = '2d', keyFile = process.env.FLOPROUTER_KEY_FILE, seedFile = process.env.FLOPROUTER_SEED_FILE, passwordFile = process.env.FLOPROUTER_PASSWORD_FILE } = {}) {
  if (!keyFile && !seedFile) throw new Error('set FLOPROUTER_KEY_FILE or FLOPROUTER_SEED_FILE');
  const [cmd, ...pre] = (process.env.FLOPROUTER_CLI || 'npx -y floprouter@latest').split(' ');
  const args = [...pre, 'grant', '--auto-renew', '--renew-before', renewBefore, '--yes', '--json',
    ...(keyFile ? ['--key-file', keyFile] : ['--seed-file', seedFile]), ...(passwordFile ? ['--password-file', passwordFile] : [])];
  const { stdout } = await promisify(execFile)(cmd, args, { env: process.env, timeout: 600_000 });
  return JSON.parse(stdout);
}

// Example: check before work, and on a timer.
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await keepGrantAlive();
  console.log(`grant: ${r.action} (${r.reason})${r.tx ? `, tx ${r.tx}` : ''}`);
  // setInterval(() => keepGrantAlive().catch((e) => console.error('grant check failed:', e.message)), 3_600_000);
}
