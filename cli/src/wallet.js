// Local wallet: load a key pair from a polkadot-js JSON key file, a seed file or a hidden prompt; connect to the
// chain; sign and submit extrinsics. Nothing here sends key material anywhere. The router only ever receives the
// address, a signature over its challenge, and (through the chain) extrinsics signed here.
import fs from 'node:fs';
import { askHidden, err, yellow } from './io.js';

let polkadot;
async function lib() {
  if (!polkadot) {
    const [api, keyring, util, crypto] = await Promise.all([
      import('@polkadot/api'), import('@polkadot/keyring'), import('@polkadot/util'), import('@polkadot/util-crypto'),
    ]);
    await crypto.cryptoWaitReady();
    polkadot = { api, keyring, util, crypto };
  }
  return polkadot;
}

function checkFileMode(file) {
  const st = fs.statSync(file);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    err(yellow(`warning: ${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`));
  }
}

/**
 * Returns a key pair. Sources, in order: --key-file (polkadot-js JSON export), --seed-file (a file holding a mnemonic,
 * a 0x seed or a secret URI), FLOPROUTER_KEY_FILE / FLOPROUTER_SEED_FILE, else a hidden prompt for the mnemonic.
 * A seed is never accepted as a command-line argument.
 */
export async function loadSigner({ keyFile, seedFile, passwordFile, type = 'sr25519' } = {}) {
  const { keyring: { Keyring } } = await lib();
  const kr = new Keyring({ type, ss58Format: 42 });
  keyFile ??= process.env.FLOPROUTER_KEY_FILE;
  seedFile ??= keyFile ? undefined : process.env.FLOPROUTER_SEED_FILE;
  if (keyFile) {
    checkFileMode(keyFile);
    const json = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const pair = kr.addFromJson(json);
    const encrypted = Array.isArray(json?.encoding?.type) ? !json.encoding.type.includes('none') : true;
    let password = '';
    if (encrypted) {
      password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '') : await askHidden(`Password for ${pair.address}: `);
    }
    pair.decodePkcs8(password);
    return pair;
  }
  let suri;
  if (seedFile) { checkFileMode(seedFile); suri = fs.readFileSync(seedFile, 'utf8').trim(); }
  else suri = (await askHidden('Mnemonic, 0x seed or secret URI (input hidden): ')).trim();
  if (!suri) throw new Error('empty seed');
  return kr.addFromUri(suri);
}

export async function signChallenge(pair, challenge, { wrap = false } = {}) {
  const { util } = await lib();
  const msg = wrap ? util.u8aWrapBytes(util.stringToU8a(challenge)) : util.stringToU8a(challenge);
  return util.u8aToHex(pair.sign(msg));
}

export async function isValidAddress(address) {
  const { crypto } = await lib();
  try { crypto.decodeAddress(address); return true; } catch { return false; }
}

/** Connects to the chain and refuses to continue if it is not the network the router says it runs on. */
export async function connect(rpc, expectedGenesis) {
  const { api: { ApiPromise, WsProvider } } = await lib();
  const provider = new WsProvider(rpc, 2_500, {}, 30_000);
  const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  const genesis = api.genesisHash.toHex();
  if (expectedGenesis && genesis !== expectedGenesis) {
    await api.disconnect();
    throw new Error(`RPC ${rpc} is chain ${genesis}, but the router runs on ${expectedGenesis}; refusing to sign`);
  }
  return api;
}

export async function toRaw(api, flop) {
  const decimals = api.registry.chainDecimals[0] ?? 18;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(flop).trim());
  if (!m || (m[2]?.length ?? 0) > decimals) throw new Error(`not a FLOP amount: ${flop}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

export function fromRaw(api, raw) {
  const decimals = api.registry.chainDecimals[0] ?? 18;
  const v = BigInt(raw); const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${v / base}${frac ? '.' + frac : ''}`;
}

/** Signs and submits, resolves when finalized; rejects on a dispatch error. */
export function signAndWait(api, tx, pair, onStatus, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    let unsub; let hash;
    const timer = setTimeout(() => { unsub?.(); reject(new Error(`no finalization after ${timeoutMs / 1000} s; the outcome is unknown. Check the account on the explorer before trying again${hash ? ` (tx ${hash})` : ''}`)); }, timeoutMs);
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    resolve = done(resolve); reject = done(reject);
    tx.signAndSend(pair, ({ status, dispatchError, txHash, events }) => {
      hash = txHash?.toHex?.();
      onStatus?.(status.type);
      if (dispatchError) {
        unsub?.();
        if (dispatchError.isModule) {
          const e = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${e.section}.${e.name}: ${e.docs.join(' ')}`));
        }
        return reject(new Error(dispatchError.toString()));
      }
      if (status.isFinalized) {
        unsub?.();
        const failed = events.find(({ event }) => api.events.utility?.BatchInterrupted?.is(event));
        if (failed) return reject(new Error('batch interrupted: ' + failed.event.data.toString()));
        resolve({ tx: txHash.toHex(), block: status.asFinalized.toHex() });
      }
    }).then((u) => { unsub = u; }, reject);
  });
}
