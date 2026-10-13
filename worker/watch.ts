// The runner watchdog. A runner container is meant to stop 3 minutes after its last check, but containers were seen
// still running 40 hours later (the platform's sleep timer did not fire), and a running container is billed by the
// second. So every runner use is noted here, and a cron (every 5 minutes, see index.ts scheduled()) stops any runner
// not used for 12 minutes. A stopped runner starts again on its next check.
import { DurableObject } from 'cloudflare:workers';

export const IDLE_MS = 12 * 60_000;

export class RunnerWatch extends DurableObject {
  /** A runner was just used (or started). */
  async touch(name: string): Promise<void> {
    await this.ctx.storage.put(`r:${name}`, Date.now());
  }
  /** Runners not used for `idleMs`. */
  async idle(idleMs = IDLE_MS): Promise<string[]> {
    const cutoff = Date.now() - idleMs;
    const out: string[] = [];
    for (const [k, at] of await this.ctx.storage.list<number>({ prefix: 'r:' })) if (at < cutoff) out.push(k.slice(2));
    return out;
  }
  /** The runners noted under a name prefix (a project's: `<project>/`), idle or not. */
  async named(prefix: string): Promise<string[]> {
    return [...(await this.ctx.storage.list({ prefix: `r:${prefix}` })).keys()].map((k) => k.slice(2));
  }
  async forget(names: string[]): Promise<void> {
    await this.ctx.storage.delete(names.map((n) => `r:${n}`));
  }
  async known(): Promise<number> {
    return (await this.ctx.storage.list({ prefix: 'r:' })).size;
  }
}
