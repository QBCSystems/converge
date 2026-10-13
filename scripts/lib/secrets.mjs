// Encryption at rest for the credentials converge keeps in ASQL (provider API keys, the Cloudflare token and admin key).
//
// A stored secret is `enc1:` + base64(iv || auth tag || ciphertext), AES-256-GCM, so a copy of the ASQL data, a binlog
// or a replica is useless without the key and any tampering is caught before plaintext comes back. The key is 32 random
// bytes in a 0600 file beside the other local state (CONVERGE_SECRET_KEY_FILE, default ~/.converge-local/secret.key),
// created on first use. A value without the prefix is a plaintext one from before; it still reads, and is encrypted the
// next time it is written (or at once by encryptStored()).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePrivate, writePrivate } from './private-file.mjs';

const PREFIX = 'enc1:';
const IV = 12;
const TAG = 16;

const keyFile = () => process.env.CONVERGE_SECRET_KEY_FILE || path.join(os.homedir(), '.converge-local', 'secret.key');

let cached = null;
let cachedFor = '';
function key() {
  const file = keyFile();
  if (cached && cachedFor === file) return cached;
  let raw = null;
  try { raw = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch { /* not created yet */ }
  if (!raw || raw.length !== 32) {
    raw = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivate(file, `${raw.toString('hex')}\n`, { flag: 'wx' });
  } else if (process.platform === 'win32') {
    makePrivate(file);   // a key made before this restricted it (Windows ignored its 0600): once per process
  }
  cached = raw; cachedFor = file;
  return raw;
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** The storable form of a secret: '' stays '', an already-encrypted value is left alone. */
export function seal(plain) {
  const text = plain === undefined || plain === null ? '' : String(plain);
  if (!text || isEncrypted(text)) return text;
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** The secret a stored value holds. A plaintext (pre-encryption) value comes back as it is; a bad blob throws. */
export function open(stored) {
  const text = stored === undefined || stored === null ? '' : String(stored);
  if (!isEncrypted(text)) return text;
  const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
  if (raw.length < IV + TAG) throw new Error('stored secret is truncated');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV));
  d.setAuthTag(raw.subarray(IV, IV + TAG));
  try { return Buffer.concat([d.update(raw.subarray(IV + TAG)), d.final()]).toString('utf8'); }
  catch { throw new Error(`stored secret cannot be decrypted with ${keyFile()}`); }
}
