// Checking converge's evidence from outside converge: agents' SSH commit signatures (what git's gpg.format=ssh writes)
// and the transparency log over the engine's receipts (RFC 9162 Merkle proofs), with nothing but Node's own crypto.
// The engine makes these (converge-engine/src/log.cpp, push_check.cpp); this is the other side, written apart from it
// on purpose, so a mistake in one does not hide in the other.
import crypto from 'node:crypto';

const spki = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });

/** A commit object's bytes split into what was signed and its gpgsig header ('' when unsigned), as git splits them. */
export function splitSignature(object) {
  const eoh = object.indexOf('\n\n');
  const head = eoh < 0 ? object : object.slice(0, eoh + 1);
  let payload = '', sig = '', inSig = false;
  for (const line of head.split(/(?<=\n)/)) {
    if (inSig && line.startsWith(' ')) sig += line.slice(1);
    else if (line.startsWith('gpgsig ')) { inSig = true; sig += line.slice(7); }
    else { inSig = false; payload += line; }
  }
  if (eoh >= 0) payload += object.slice(eoh + 1);
  return { payload, signature: sig };
}

/**
 * An SSHSIG signature (OpenSSH PROTOCOL.sshsig) over `message` in namespace `ns`: { ok, key, problem } where key is
 * the signer's "ssh-ed25519 AAAA..." line. Ed25519 only.
 */
export function sshsigVerify(armored, message, ns = 'git') {
  const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(armored);
  if (!m) return { ok: false, problem: 'not an SSH signature' };
  const b = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  let at = 0;
  const u32 = () => { const v = b.readUInt32BE(at); at += 4; return v; };
  const str = () => { const n = u32(); const s = b.subarray(at, at + n); at += n; if (at > b.length) throw new Error('short'); return s; };
  try {
    if (b.subarray(0, 6).toString() !== 'SSHSIG') return { ok: false, problem: 'not an SSH signature' };
    at = 6;
    if (u32() !== 1) return { ok: false, problem: 'unknown SSH signature version' };
    const pub = str(), sigNs = str().toString(), reserved = str(), hash = str().toString(), sigblob = str();
    if (sigNs !== ns) return { ok: false, problem: `namespace ${sigNs}, not ${ns}` };
    let pat = 0;
    const pstr = (buf) => { const n = buf.readUInt32BE(pat); pat += 4; const s = buf.subarray(pat, pat + n); pat += n; return s; };
    const ktype = pstr(pub).toString(), kraw = pstr(pub);
    if (ktype !== 'ssh-ed25519' || kraw.length !== 32) return { ok: false, problem: `a ${ktype} key (this checks ssh-ed25519)` };
    pat = 0;
    const stype = pstr(sigblob).toString(), sraw = pstr(sigblob);
    if (stype !== 'ssh-ed25519' || sraw.length !== 64) return { ok: false, problem: 'malformed signature' };
    if (hash !== 'sha512' && hash !== 'sha256') return { ok: false, problem: `hash ${hash}` };
    const lenStr = (x) => { const l = Buffer.alloc(4); l.writeUInt32BE(x.length); return Buffer.concat([l, x]); };
    const signed = Buffer.concat([Buffer.from('SSHSIG'), lenStr(Buffer.from(ns)), lenStr(reserved), lenStr(Buffer.from(hash)),
      lenStr(crypto.createHash(hash).update(message).digest())]);
    const key = `ssh-ed25519 ${pub.toString('base64')}`;
    const ok = crypto.verify(null, signed, spki(kraw), sraw);
    return ok ? { ok, key } : { ok, key, problem: 'bad signature' };
  } catch {
    return { ok: false, problem: 'malformed SSH signature' };
  }
}

/** "ssh-ed25519 AAAA... comment" -> "ssh-ed25519 AAAA..." ('' when not one). */
export const canonicalKey = (line) => { const [t, b] = String(line || '').trim().split(/\s+/); return t === 'ssh-ed25519' && b ? `${t} ${b}` : ''; };

// ---- the receipts' transparency log (RFC 9162 2.1) ----------------------------------------------------------------
const H = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
export const leafHash = (data) => H(Buffer.from([0]), Buffer.from(data));
const node = (l, r) => H(Buffer.from([1]), l, r);

/** RFC 9162 2.1.3.2: leaf `index` of a tree of `size` leaves, given its audit path, has root `root`. */
export function verifyInclusion(leaf, index, size, proof, root) {
  if (index >= size) return false;
  let fn = BigInt(index), sn = BigInt(size - 1), r = leaf;
  for (const hex of proof) {
    const p = Buffer.from(hex, 'hex');
    if (sn === 0n) return false;
    if ((fn & 1n) || fn === sn) {
      r = node(p, r);
      if (!(fn & 1n)) while (fn !== 0n && !(fn & 1n)) { fn >>= 1n; sn >>= 1n; }
    } else r = node(r, p);
    fn >>= 1n; sn >>= 1n;
  }
  return sn === 0n && r.equals(Buffer.from(root, 'hex'));
}

/** RFC 9162 2.1.4.2: the tree of size m (root rootM) is a prefix of the tree of size n (root rootN). */
export function verifyConsistency(m, n, rootM, rootN, proof) {
  if (m === 0 || m > n) return false;
  if (m === n) return proof.length === 0 && rootM === rootN;
  if (!proof.length) return false;
  const p = proof.map((h) => Buffer.from(h, 'hex'));
  if ((m & (m - 1)) === 0) p.unshift(Buffer.from(rootM, 'hex'));
  let fn = BigInt(m - 1), sn = BigInt(n - 1);
  while (fn & 1n) { fn >>= 1n; sn >>= 1n; }
  let fr = p[0], sr = p[0];
  for (const c of p.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) || fn === sn) {
      fr = node(c, fr); sr = node(c, sr);
      if (!(fn & 1n)) while (fn !== 0n && !(fn & 1n)) { fn >>= 1n; sn >>= 1n; }
    } else sr = node(sr, c);
    fn >>= 1n; sn >>= 1n;
  }
  return fr.equals(Buffer.from(rootM, 'hex')) && sr.equals(Buffer.from(rootN, 'hex')) && sn === 0n;
}

/** A signed tree head as the engine serves it, checked against the engine key: the parsed head, or throws. */
export function checkTreeHead(sth, keyHex) {
  if (keyHex && sth.key !== keyHex) throw new Error(`the tree head is signed by ${String(sth.key).slice(0, 16)}..., not the engine key ${keyHex.slice(0, 16)}...`);
  const ok = crypto.verify(null, Buffer.from(sth.tree_head), spki(Buffer.from(sth.key, 'hex')), Buffer.from(sth.signature, 'hex'));
  if (!ok) throw new Error('the tree head signature does not verify');
  return JSON.parse(sth.tree_head);
}
