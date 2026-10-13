// The HTTP framing the engine bridge needs (worker/engine-wasm.ts): the engine's git writes HTTP/1.1
// requests into a "connection"; these find each whole request in the bytes so it can be carried out
// with fetch(). Pure functions, so they can be tested on their own.
const enc = new TextEncoder();
const dec = new TextDecoder();

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function indexOf(hay: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export const CRLFCRLF = [13, 10, 13, 10];
export const CRLF = [13, 10];

/** One whole HTTP/1.1 request at the front of `buf`, or null if more bytes are needed. */
export function takeRequest(buf: Uint8Array): { method: string; path: string; headers: [string, string][]; body: Uint8Array; rest: Uint8Array } | null {
  const end = indexOf(buf, CRLFCRLF);
  if (end < 0) return null;
  const lines = dec.decode(buf.subarray(0, end)).split('\r\n');
  const [method, path] = lines[0].split(' ');
  const headers: [string, string][] = [];
  for (const l of lines.slice(1)) {
    const c = l.indexOf(':');
    if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
  }
  const h = (n: string) => headers.find(([k]) => k.toLowerCase() === n)?.[1];
  let pos = end + 4;
  if ((h('transfer-encoding') || '').toLowerCase().includes('chunked')) {
    let body = new Uint8Array(0);
    for (;;) {
      const le = indexOf(buf, CRLF, pos);
      if (le < 0) return null;
      const size = parseInt(dec.decode(buf.subarray(pos, le)), 16);
      if (Number.isNaN(size)) throw new Error('bad chunk size from the engine');
      if (le + 2 + size + 2 > buf.length) return null;
      if (size === 0) { pos = le + 4; break; }
      body = concat(body, buf.subarray(le + 2, le + 2 + size));
      pos = le + 2 + size + 2;
    }
    return { method, path, headers, body, rest: buf.subarray(pos) };
  }
  const len = Number(h('content-length') || 0);
  if (buf.length < pos + len) return null;
  return { method, path, headers, body: buf.subarray(pos, pos + len), rest: buf.subarray(pos + len) };
}

