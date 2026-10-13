// The runners: where converge runs a change's checks (the project's tests, the agent's reported
// command, the evidence of its claims, the task's acceptance checks). Each is a container running
// runner/runner.mjs: it fetches the commit from the repository and runs the job's script fenced by
// converge-jail. The image is built and pushed by scripts/oci.mjs (no Docker); see README.
//
// The project's Durable Object calls run(job) over RPC; a job's workspace always maps to the same
// runner, so an agent's checkout stays warm between its commits.
import { Container } from '@cloudflare/containers';
import type { Env } from './index.ts';

export class Runner extends Container<Env> {
  override defaultPort = 8080;
  // Idle runners stop soon: they cost while running, and the account has a cap on live instances.
  override sleepAfter = '3m';

  private runnerEnv(): Record<string, string> {
    return { RUNNER_KEY: this.env.ENGINE_SHARED_KEY || '', RUNNER_ROOT: '/work' };
  }

  /** Note this use for the watchdog (worker/watch.ts): a runner nobody touches for 12 minutes is stopped by the cron. */
  private touch(): void {
    const name = (this.ctx.id as { name?: string }).name;
    if (name) this.ctx.waitUntil(this.env.RUNNERWATCH.get(this.env.RUNNERWATCH.idFromName('all')).touch(name).catch(() => {}));
  }

  override async onStart(): Promise<void> {
    this.envVars = this.runnerEnv();
  }

  /** Stop this runner's container now (idle capacity back to the account). */
  async reap(): Promise<void> {
    await this.destroy().catch(() => {});
  }

  /** Start the container (if it is not running) and answer when it is up: warm before a run. */
  async warm(): Promise<boolean> {
    this.touch();
    this.envVars = this.runnerEnv();
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await this.containerFetch('http://runner/health', { headers: { 'X-Runner-Key': this.env.ENGINE_SHARED_KEY || '' } }, 8080);
        if (res.ok) return true;
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    return false;
  }

  /** The jail held to its promises on this runner: check-jail.sh's verdicts (runner/runner.mjs GET /jail). */
  async jailReport(): Promise<Record<string, unknown>> {
    this.touch();
    this.envVars = this.runnerEnv();
    const res = await this.containerFetch('http://runner/jail', { headers: { 'X-Runner-Key': this.env.ENGINE_SHARED_KEY || '' } }, 8080);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Run one verification job and return the runner's result. */
  async run(job: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.touch();
    this.envVars = this.runnerEnv();
    const body = JSON.stringify(job);
    const headers = { 'Content-Type': 'application/json', 'X-Runner-Key': this.env.ENGINE_SHARED_KEY || '' };
    // A container may be starting or replaced (a rollout, sleepAfter) between the library's check
    // and the request: give it a moment and ask again.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.containerFetch('http://runner/run', { method: 'POST', headers, body }, 8080);
        if (res.status === 503 && attempt < 4) throw new Error('runner answered 503');
        if (!res.ok) return { exit_code: -1, timed_out: false, output_tail: `[converge] the runner answered ${res.status}: ${(await res.text()).slice(0, 2000)}\n` };
        return (await res.json()) as Record<string, unknown>;
      } catch (err: any) {
        if (attempt >= 4 || !/not running|proxying request|answered 503|Network connection lost|Failed to start/i.test(String(err?.message || err))) throw err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
}
