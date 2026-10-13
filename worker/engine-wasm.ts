// converge's engine, built on the kernel and compiled to WebAssembly (worker/engine.wasm, shipped built), running inside the project's
// Durable Object: no container, no network hop between the object and its engine.
//
// The engine is ordinary blocking C++. Where it waits on the network, the import it calls is a
// WebAssembly.Suspending function (JSPI): the module pauses while the promise settles, so one call
// may span several fetches. Calls are queued here, one at a time, because a paused call must not be
// re-entered.
//
// The network: inside Cloudflare a Worker cannot open TCP to Cloudflare's own addresses (Artifacts
// lives there), so the engine's git speaks plain HTTP into a "connection" this bridge reads as HTTP
// requests and carries out with fetch() over https. Port 80 means https on the same host (the engine
// holds its https remotes as http, see RepoCache::transport_url); any other port is http there.
import engineModule from './engine.wasm';

type Init = { engine_key: string; receipt_seed?: string };

interface Conn {
  host: string;
  port: number;
  out: Uint8Array;          // request bytes not yet consumed
  inbox: Uint8Array;        // response bytes not yet read by the engine
  pending: Promise<void>[]; // fetches under way, in request order
  closed: boolean;
}

import { concat, indexOf, takeRequest, CRLFCRLF } from './engine-http.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Engine {
  private inst!: WebAssembly.Instance;
  private conns = new Map<number, Conn>();
  private nextConn = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private serveFn!: (ptr: number, len: number) => Promise<number>;
  private logLines: string[] = [];
  /** The receipt seed the engine made at init because it was given none: the caller stores it once, then clears it. Never logged. */
  generatedSeed = '';

  static async create(init: Init): Promise<Engine> {
    const e = new Engine();
    await e.instantiate(init);
    return e;
  }

  private get mem(): Uint8Array {
    return new Uint8Array((this.inst.exports.memory as WebAssembly.Memory).buffer);
  }
  private view(): DataView {
    return new DataView((this.inst.exports.memory as WebAssembly.Memory).buffer);
  }
  private str(ptr: number, len: number): string {
    return dec.decode(this.mem.subarray(ptr, ptr + len));
  }

  private async instantiate(init: Init): Promise<void> {
    const S = (WebAssembly as any).Suspending;
    const wasi = this.wasi();
    const cv = {
      net_connect: (hostPtr: number, hostLen: number, port: number) => {
        const id = this.nextConn++;
        this.conns.set(id, { host: this.str(hostPtr, hostLen), port, out: new Uint8Array(0), inbox: new Uint8Array(0), pending: [], closed: false });
        return id;
      },
      net_send: (h: number, ptr: number, len: number) => {
        const c = this.conns.get(h);
        if (!c || c.closed) return -1;
        c.out = concat(c.out, this.mem.slice(ptr, ptr + len));
        for (let req = takeRequest(c.out); req; req = takeRequest(c.out)) {
          c.out = req.rest;
          c.pending.push(this.carry(c, req));
        }
        return len;
      },
      net_recv: new S(async (h: number, ptr: number, cap: number, timeoutMs: number) => {
        const c = this.conns.get(h);
        if (!c) return -1;
        if (c.inbox.length === 0 && c.pending.length) {
          const first = c.pending[0];
          const timedOut = await Promise.race([first.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), Math.max(timeoutMs, 1)))]);
          if (timedOut) return -2;
          c.pending.shift();
        }
        if (c.inbox.length === 0) return 0; // nothing more will come on this connection
        const n = Math.min(cap, c.inbox.length);
        this.mem.set(c.inbox.subarray(0, n), ptr); // memory may have grown while we waited: fresh view
        c.inbox = c.inbox.slice(n);
        return n;
      }),
      net_close: (h: number) => {
        const c = this.conns.get(h);
        if (c) c.closed = true;
        this.conns.delete(h);
      },
      log: (ptr: number, len: number) => console.log('[engine]', this.str(ptr, len)),
    };
    this.inst = await WebAssembly.instantiate(engineModule as WebAssembly.Module, { cv, wasi_snapshot_preview1: wasi });
    (this.inst.exports._initialize as () => void)?.();
    const P = (WebAssembly as any).promising;
    this.serveFn = P(this.inst.exports.cv_serve);
    const cfg = enc.encode(JSON.stringify(init));
    const p = this.alloc(cfg);
    const rc = await P(this.inst.exports.cv_init)(p, cfg.length);
    this.free(p);
    const said = this.out((this.inst.exports.cv_out_ptr as () => number)());
    if (rc !== 0) throw new Error(`engine init: ${said}`);
    // Given no receipt_seed, the engine makes one and says {"receipt_seed":"<64 hex>"}: hand it up to be kept.
    if (said) {
      try {
        const seed = JSON.parse(said).receipt_seed;
        if (typeof seed === 'string' && /^[0-9a-f]{64}$/.test(seed)) this.generatedSeed = seed;
      } catch {
        // not the seed: nothing to keep
      }
    }
  }

  /** One HTTP request from the engine's git, carried out with fetch; the response becomes bytes. */
  private async carry(c: Conn, req: { method: string; path: string; headers: [string, string][]; body: Uint8Array }): Promise<void> {
    const url = c.port === 80 ? `https://${c.host}${req.path}` : `http://${c.host}:${c.port}${req.path}`;
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) headers.append(k, v);
    let head: string;
    let body: Uint8Array;
    try {
      const res = await fetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body });
      body = new Uint8Array(await res.arrayBuffer());
      head = `HTTP/1.1 ${res.status} ${res.statusText || 'OK'}\r\n`;
      res.headers.forEach((v, k) => {
        if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) head += `${k}: ${v}\r\n`;
      });
    } catch (err: any) {
      body = enc.encode(String(err?.message || err));
      head = 'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n';
    }
    head += `Content-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n`;
    c.inbox = concat(concat(c.inbox, enc.encode(head)), body);
  }

  private alloc(bytes: Uint8Array): number {
    const p = (this.inst.exports.cv_alloc as (n: number) => number)(bytes.length);
    this.mem.set(bytes, p);
    return p;
  }
  private free(p: number): void {
    (this.inst.exports.cv_free as (p: number) => void)(p);
  }
  private out(ptr?: number): string {
    const len = (this.inst.exports.cv_out_len as () => number)();
    return ptr === undefined ? '' : this.str(ptr, len);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** An engine HTTP call, exactly as its socket would carry it. */
  request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.exclusive(async () => {
      const body = typeof init.body === 'string' ? enc.encode(init.body) : new Uint8Array(0);
      let head = `${init.method || 'GET'} ${path} HTTP/1.1\r\nHost: engine\r\n`;
      new Headers(init.headers).forEach((v, k) => { if (k !== 'content-length' && k !== 'host') head += `${k}: ${v}\r\n`; });
      head += `Content-Length: ${body.length}\r\n\r\n`;
      const req = concat(enc.encode(head), body);
      const p = this.alloc(req);
      let outPtr: number;
      try {
        outPtr = await this.serveFn(p, req.length);
      } finally {
        this.free(p);
      }
      const len = (this.inst.exports.cv_out_len as () => number)();
      const raw = this.mem.slice(outPtr, outPtr + len);
      const end = indexOf(raw, CRLFCRLF);
      const statusLine = dec.decode(raw.subarray(0, raw.indexOf(13)));
      const status = Number(statusLine.split(' ')[1]) || 500;
      return new Response(raw.subarray(end < 0 ? raw.length : end + 4), { status, headers: { 'Content-Type': 'application/json' } });
    });
  }

  /** Verification jobs the engine queued for a runner. */
  takeJobs(): Promise<any[]> {
    return this.exclusive(async () => {
      const p = (this.inst.exports.cv_take_jobs as () => number)();
      return JSON.parse(this.out(p) || '[]');
    });
  }

  /** A runner's result for one job. */
  jobDone(result: unknown): Promise<void> {
    return this.exclusive(async () => {
      const b = enc.encode(JSON.stringify(result));
      const p = this.alloc(b);
      (this.inst.exports.cv_job_done as (p: number, n: number) => void)(p, b.length);
      this.free(p);
    });
  }

  // ---- the little WASI the engine's C library asks for ----
  private wasi() {
    const ENOSYS = 52, EBADF = 8, ENOENT = 44;
    return {
      environ_sizes_get: (countPtr: number, sizePtr: number) => { this.view().setUint32(countPtr, 0, true); this.view().setUint32(sizePtr, 0, true); return 0; },
      environ_get: () => 0,
      clock_time_get: (_id: number, _precision: bigint, out: number) => { this.view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true); return 0; },
      fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
        const v = this.view();
        let n = 0;
        let text = '';
        for (let i = 0; i < iovsLen; i++) {
          const p = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true);
          text += this.str(p, l);
          n += l;
        }
        v.setUint32(nwritten, n, true);
        if (fd === 1 || fd === 2) {
          const lines = (this.logLines.pop() || '') + text;
          const parts = lines.split('\n');
          for (const l of parts.slice(0, -1)) console.log('[engine]', l);
          this.logLines.push(parts[parts.length - 1]);
        }
        return 0;
      },
      fd_read: () => EBADF,
      fd_close: () => 0,
      fd_seek: () => ENOSYS,
      fd_fdstat_get: (fd: number, out: number) => {
        if (fd > 2) return EBADF;
        const v = this.view();
        v.setUint8(out, 2); // character device
        return 0;
      },
      // No directories are preopened: the engine's files live in its host's memory (host_wasm.cpp),
      // so libc's own open (a font, a canvas save inside aios) finds nothing and says so.
      fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF,
      fd_fdstat_set_flags: () => EBADF,
      path_open: () => ENOENT,
      // A sleep (libc++'s this_thread::sleep_for): the engine runs on one thread with nothing to wait for, so it
      // returns at once.
      poll_oneoff: () => ENOSYS,
      proc_exit: (code: number) => { throw new Error(`the engine exited (${code})`); },
      random_get: (ptr: number, len: number) => {
        for (let off = 0; off < len; off += 65536) crypto.getRandomValues(this.mem.subarray(ptr + off, ptr + Math.min(len, off + 65536)));
        return 0;
      },
    };
  }
}
