// Landing receipts, checked here in the browser: each Landed event carries the engine's signed
// receipt (engine/src/receipt.hpp). We verify the Ed25519 signature against the project's public key
// with WebCrypto and check the hash chain ourselves, so what the cockpit shows does not rest on the
// server saying so.

const results = new Map(); // receipt_hash -> { ok, why }
let keyPromise = null;
let keyHex = '';

const hexBytes = (hex) => Uint8Array.from((hex.match(/../g) || []).map((b) => parseInt(b, 16)));
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

function importKey(hex) {
  if (hex !== keyHex) {
    keyHex = hex;
    keyPromise = crypto.subtle.importKey('raw', hexBytes(hex), { name: 'Ed25519' }, false, ['verify']).catch(() => null);
  }
  return keyPromise;
}

/** Verify every sealed landing we hold; calls onChange when results change. */
export async function verifyReceipts(state, onChange) {
  const key = state.project.receipt_key;
  if (!key || !globalThis.crypto?.subtle) return;
  const sealed = state.landings.filter((e) => e.receipt);
  let changed = false;
  const pubkey = await importKey(key);
  for (let i = 0; i < sealed.length; i++) {
    const ev = sealed[i];
    if (results.has(ev.receipt_hash)) continue;
    let ok = false;
    let restart = false;
    let why = '';
    try {
      const r = JSON.parse(ev.receipt);
      if (!pubkey) why = 'this browser cannot verify Ed25519';
      else if (!(await crypto.subtle.verify({ name: 'Ed25519' }, pubkey, hexBytes(ev.signature), new TextEncoder().encode(ev.receipt)))) why = 'signature does not verify';
      else if ((await sha256(ev.receipt)) !== ev.receipt_hash) why = 'hash does not match the receipt';
      else if (r.commit !== ev.commit) why = `receipt names ${String(r.commit).slice(0, 12)}`;
      else {
        const prev = sealed[i - 1];
        // Validly signed but numbered from 1 again with no predecessor: the engine restarted its chain (an engine
        // bug, since fixed, that lost the chain's tip after a restart). Shown as a restart, never as verified chain.
        if (prev && r.seq === 1 && r.prev === '') { ok = true; restart = true; }
        else if (prev && (await sha256(prev.receipt)) !== r.prev) why = 'does not chain to the previous landing';
        else if (!prev && r.seq === 1 && r.prev !== '') why = 'first receipt names a predecessor';
        else ok = true;
      }
    } catch {
      why = 'malformed receipt';
    }
    results.set(ev.receipt_hash, { ok, why, restart });
    changed = true;
  }
  if (changed) onChange();
}

function receiptResult(ev) {
  if (!ev.receipt) return { state: 'unsealed' };
  const r = results.get(ev.receipt_hash);
  if (!r) return { state: 'checking' };
  return r.ok ? { state: 'verified', restart: !!r.restart } : { state: 'bad', why: r.why };
}

export function receiptSummary(state) {
  const sealed = state.landings.filter((e) => e.receipt);
  let verified = 0, bad = 0, restarts = 0;
  for (const e of sealed) {
    const r = receiptResult(e);
    if (r.state === 'verified') verified++;
    if (r.restart) restarts++;
    if (r.state === 'bad') bad++;
  }
  return { sealed: sealed.length, verified, bad, restarts, rev: results.size };
}
