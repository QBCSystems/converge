// A file only its owner can read: secrets converge keeps on disk (the encryption key, ASQL's password, tokens).
// On POSIX that is mode 0600. Windows has no mode bits (Node accepts and ignores them), so there the file's
// inherited ACL is replaced by one entry: this user, full control. (The low-integrity fence hides these files
// from agents and checks as well; this is what keeps them from the machine's other accounts.)
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const me = () => {
  const u = os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${u}` : u;
};

/** Restrict an existing file to its owner. Throws when that cannot be done (a secret is never left open). */
export function makePrivate(file) {
  if (!WIN) { fs.chmodSync(file, 0o600); return; }
  const r = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${me()}:F`], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`cannot restrict ${file} to ${me()}: ${(r.stdout || r.stderr || r.error?.message || '').trim()}`);
}

/** fs.writeFileSync for a secret: written 0600, then (Windows) its ACL made this user's only. */
export function writePrivate(file, data, opts = {}) {
  fs.writeFileSync(file, data, { ...opts, mode: 0o600 });
  makePrivate(file);
}

/** Whether only this user can reach the file: mode 0600 (no group or other bits), or on Windows one ACL entry, for this user. */
export function isPrivate(file) {
  if (!WIN) return (fs.statSync(file).mode & 0o077) === 0;
  const r = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^Successfully processed/i.test(l));
  // The first line carries the path, then one entry per line: "DOMAIN\user:(F)".
  // (A "Mandatory Label\..." line is an integrity label, not an access grant: the fence's no-read-up.)
  const entries = lines.map((l, i) => (i === 0 ? l.slice(file.length).trim() : l)).filter((e) => !/^Mandatory Label\\/i.test(e));
  return entries.length === 1 && entries[0].toLowerCase() === `${me()}:(f)`.toLowerCase();
}
