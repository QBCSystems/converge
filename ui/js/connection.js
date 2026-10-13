// Live link to the worker: a WebSocket when it works, snapshot polling while it doesn't.
//
// Every socket gets a generation number. Callbacks from a superseded socket are ignored, which
// fixes the classic bug where closing the old socket during a reconnect flips the status of the new one.

const POLL_MS = 4000;
const HEARTBEAT_MS = 25_000;
const SNAPSHOT_GRACE_MS = 4000;
const FETCH_TIMEOUT_MS = 8000;
const BACKOFF = [1000, 2000, 4000, 8000, 15_000, 30_000];

export const GONE_TEXT = 'This project no longer exists.';

/** The open project answered 404: stop every retry and poll, say so, and leave for the projects list. */
export function handleProjectGone(conn) {
  conn.stop();
  conn.onStatus({ mode: 'gone', text: GONE_TEXT });
  conn.onGone?.(GONE_TEXT);
}

export class Connection {
  /**
   * @param {object} o
   * @param {() => {project: string, viewKey: string, base?: string, keyInUrl?: boolean}} o.getConfig
   * @param {(snapshot: object) => void} o.onSnapshot
   * @param {(event: object) => void} o.onEvent
   * @param {(status: {mode: 'connecting'|'live'|'polling'|'offline'|'unauthorized', text: string}) => void} o.onStatus
   */
  constructor({ getConfig, onSnapshot, onEvent, onStatus, onGone }) {
    Object.assign(this, { getConfig, onSnapshot, onEvent, onStatus, onGone });
    this.gen = 0;
    this.ws = null;
    this.live = false;
    this.stopped = true;
    this.attempt = 0;
    this.timers = { poll: null, retry: null, heartbeat: null, grace: null };
    this.inflight = null;

    window.addEventListener('online', () => !this.stopped && !this.live && this.connect());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.stopped && !this.live) this.fetchNow();
    });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.teardown();
    this.clearTimers();
  }

  /** Drop everything and reconnect from scratch (after settings change or a manual retry). */
  restart() {
    this.stop();
    this.attempt = 0;
    this.start();
  }

  clearTimers() {
    for (const k of Object.keys(this.timers)) {
      clearTimeout(this.timers[k]);
      clearInterval(this.timers[k]);
      this.timers[k] = null;
    }
  }

  teardown() {
    this.gen++;
    this.live = false;
    this.inflight?.abort();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  // A browser cannot set headers on a WebSocket: the key goes as a subprotocol (`converge.key.<base64url>`), not in the
  // URL where it lands in logs and history. Only the local platform's dev server, which reads ?key=, still gets it there.
  wsUrl() {
    const { project, viewKey, base = '', keyInUrl = false } = this.getConfig();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = viewKey && keyInUrl ? `?key=${encodeURIComponent(viewKey)}` : '';
    return `${proto}//${location.host}${base}/api/projects/${encodeURIComponent(project)}/ws${q}`;
  }

  wsProtocols() {
    const { viewKey } = this.getConfig();
    if (!viewKey) return []; // nothing to carry (a public demo, watched with no key)
    const b64url = btoa(String.fromCharCode(...new TextEncoder().encode(viewKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return ['converge', `converge.key.${b64url}`];
  }

  connect() {
    this.teardown();
    this.clearTimers();
    const gen = this.gen;
    this.onStatus({ mode: 'connecting', text: 'Connecting' });

    let ws;
    try {
      ws = new WebSocket(this.wsUrl(), this.wsProtocols());
    } catch {
      this.fallBack();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.live = true;
      this.attempt = 0;
      clearInterval(this.timers.poll);
      this.timers.poll = null;
      this.onStatus({ mode: 'live', text: 'Live' });
      this.timers.heartbeat = setInterval(() => ws.readyState === 1 && ws.send('ping'), HEARTBEAT_MS);
      // The server sends a snapshot on connect; if it never arrives, fetch one ourselves.
      this.timers.grace = setTimeout(() => gen === this.gen && this.fetchNow(), SNAPSHOT_GRACE_MS);
    };

    ws.onmessage = (e) => {
      if (gen !== this.gen || e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot') {
        clearTimeout(this.timers.grace);
        this.onSnapshot(msg);
      } else if (msg.type === 'event' && msg.event) {
        this.onEvent(msg.event); // dev-server wraps events; the worker sends them bare
      } else {
        this.onEvent(msg);
      }
    };

    ws.onclose = () => {
      if (gen !== this.gen) return;
      this.live = false;
      clearInterval(this.timers.heartbeat);
      this.fallBack();
    };
    ws.onerror = () => { /* onclose always follows and does the work */ };
  }

  /** WebSocket is down: poll for snapshots and retry the socket with backoff. */
  fallBack() {
    if (this.stopped) return;
    this.onStatus({ mode: 'polling', text: 'Polling' });
    this.fetchNow();
    if (!this.timers.poll) this.timers.poll = setInterval(() => this.fetchNow(), POLL_MS);
    const delay = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)] * (0.75 + Math.random() * 0.5);
    clearTimeout(this.timers.retry);
    this.timers.retry = setTimeout(() => !this.stopped && !this.live && this.connect(), delay);
  }

  async fetchNow() {
    if (this.stopped) return;
    const { project, viewKey } = this.getConfig();
    this.inflight?.abort();
    const ctl = (this.inflight = new AbortController());
    const timeout = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const gen = this.gen;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/state`, {
        signal: ctl.signal,
        headers: { Accept: 'application/json', ...(viewKey ? { 'X-View-Key': viewKey } : {}) },
      });
      if (gen !== this.gen) return;
      if (res.status === 401 || res.status === 403) {
        this.stop();
        this.onStatus({ mode: 'unauthorized', text: 'Key required' });
        return;
      }
      if (res.status === 404) {
        handleProjectGone(this);
        return;
      }
      if (!res.ok) {
        this.onStatus({ mode: 'offline', text: `Server error ${res.status}` });
        return;
      }
      this.onSnapshot(await res.json());
      if (!this.live) this.onStatus({ mode: 'polling', text: 'Polling' });
    } catch (err) {
      if (gen === this.gen && err.name !== 'AbortError') this.onStatus({ mode: 'offline', text: 'Offline' });
    } finally {
      clearTimeout(timeout);
    }
  }
}
