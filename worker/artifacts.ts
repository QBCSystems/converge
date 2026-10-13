/**
 * Cloudflare Artifacts client: the only module that touches env.ARTIFACTS.
 *
 * Written against the binding's published types (@cloudflare/workers-types `Artifacts`), with no
 * guessing: create / import a project repo, fork `<project>--<agent>` for each agent, and mint
 * write tokens. Tokens expire, so every credential carries its expiry and can be re-minted.
 */

export interface RepoCredentials {
  /** HTTPS git remote. */
  remote: string;
  /** Plaintext write token (basic-auth password for the remote). */
  token: string;
  /** ISO 8601 expiry of `token`. */
  expiresAt: string;
  /** Branch converge lands on. */
  defaultBranch: string;
}

/** Token lifetime we ask for. Artifacts allows 60 s .. 365 days. */
export const TOKEN_TTL_SECONDS = 30 * 24 * 3600;
/** Re-mint when a token has less than this left. */
export const TOKEN_REFRESH_MARGIN_MS = 24 * 3600 * 1000;

export const forkName = (project: string, agentId: string) => `${project}--${agentId}`;

function requireBinding(artifacts: Artifacts | undefined): Artifacts {
  if (!artifacts) throw new Error('Cloudflare ARTIFACTS binding is not configured (wrangler.jsonc "artifacts")');
  return artifacts;
}

async function writeToken(repo: ArtifactsRepo): Promise<{ token: string; expiresAt: string }> {
  const t = await repo.createToken('write', TOKEN_TTL_SECONDS);
  return { token: t.plaintext, expiresAt: t.expiresAt };
}

/**
 * Create the project's main repository, importing `importUrl` (HTTPS) when given.
 * Throws ALREADY_EXISTS for an existing repo: re-creating must not silently adopt another repo.
 */
export async function createProjectRepo(artifacts: Artifacts | undefined, project: string, importUrl?: string): Promise<RepoCredentials> {
  const a = requireBinding(artifacts);
  const created = importUrl
    ? await a.import({ source: { url: importUrl }, target: { name: project, opts: { description: `converge project ${project}` } } })
    : await a.create(project, { description: `converge project ${project}`, setDefaultBranch: 'main' });
  let defaultBranch = created.defaultBranch || 'main';
  if (importUrl) {
    // An import finishes after import() returns: wait until the repository has its history, and take
    // the branch it actually has as default (a source may use master).
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const repo = await a.get(project);
        const info = await repo.info();
        // Done when a branch has commits (an import sets no lastPushAt). The reported default can
        // name a branch the source never had (main for a master repository): take one that resolves.
        let found = '';
        for (const b of [...new Set([info.defaultBranch, 'main', 'master'].filter(Boolean))]) {
          if ((await repo.log({ ref: b, limit: 1 })).length) { found = b; break; }
        }
        if (found) { defaultBranch = found; break; }
      } catch (err: any) {
        if (err?.code !== 'IMPORT_IN_PROGRESS' && err?.code !== 'CREATE_IN_PROGRESS') throw err;
      }
      if (Date.now() > deadline) throw new Error(`the import of ${importUrl.replace(/\/\/[^/@]*@/, '//')} did not finish within 120 s; try again`);   // never the token a URL carries
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // The creation token's lifetime is not reported; mint one whose expiry we know.
  const { token, expiresAt } = await writeToken(await a.get(project));
  return { remote: created.remote, token, expiresAt, defaultBranch };
}

/** Fork main (or `fromRepo`, e.g. a stalled agent's fork) into `<project>--<agent>` and mint a write token. */
export async function createAgentFork(artifacts: Artifacts | undefined, project: string, agentId: string, fromRepo = project): Promise<RepoCredentials> {
  const a = requireBinding(artifacts);
  const name = forkName(project, agentId);
  // Artifacts answers "internal error" when many forks are made at once (a wave of agents joining):
  // back off and try again; a failed attempt may still have made the fork, so look for it first.
  for (let attempt = 0; ; attempt++) {
    try {
      const existing = attempt > 0 ? await a.get(name).then((r) => r.info()).catch(() => null) : null;
      if (existing) {
        const { token, expiresAt } = await writeToken(await a.get(name));
        return { remote: existing.remote, token, expiresAt, defaultBranch: existing.defaultBranch || 'main' };
      }
      const parent = await a.get(fromRepo);
      const forked = await parent.fork(name, { description: `converge agent ${agentId}`, defaultBranchOnly: true });
      const { token, expiresAt } = await writeToken(await a.get(forked.name));
      return { remote: forked.remote, token, expiresAt, defaultBranch: forked.defaultBranch || 'main' };
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 250));
    }
  }
}

/**
 * A new project whose main is a fork of an existing project's main (a sandbox session starts from a
 * demo project's code). Default branch only; the fork is the project's main repository.
 */
export async function createProjectFromTemplate(artifacts: Artifacts | undefined, project: string, template: string): Promise<RepoCredentials> {
  const a = requireBinding(artifacts);
  for (let attempt = 0; ; attempt++) {
    try {
      const existing = attempt > 0 ? await a.get(project).then((r) => r.info()).catch(() => null) : null;
      if (existing) {
        const { token, expiresAt } = await writeToken(await a.get(project));
        return { remote: existing.remote, token, expiresAt, defaultBranch: existing.defaultBranch || 'main' };
      }
      const parent = await a.get(template);
      const forked = await parent.fork(project, { description: `converge sandbox session ${project}`, defaultBranchOnly: true });
      const { token, expiresAt } = await writeToken(await a.get(forked.name));
      return { remote: forked.remote, token, expiresAt, defaultBranch: forked.defaultBranch || 'main' };
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 250));
    }
  }
}

/** Fresh credentials for an existing repo (main or a fork). */
export async function refreshCredentials(artifacts: Artifacts | undefined, repoName: string): Promise<RepoCredentials> {
  const a = requireBinding(artifacts);
  const repo = await a.get(repoName);
  const info = await repo.info();
  const { token, expiresAt } = await writeToken(repo);
  return { remote: info.remote, token, expiresAt, defaultBranch: info.defaultBranch || 'main' };
}

export const needsRefresh = (expiresAt: string | undefined, now = Date.now()) =>
  !expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) - now < TOKEN_REFRESH_MARGIN_MS;

/**
 * Delete a project's repositories for good: every `<project>--<agent>` fork (the ones given, and any
 * others the listing finds, such as a fork made by a retried attempt) and then main. Answers the names deleted.
 */
export async function deleteProjectRepos(artifacts: Artifacts | undefined, project: string, agentIds: string[] = []): Promise<string[]> {
  const a = requireBinding(artifacts);
  const forks = new Set(agentIds.map((id) => forkName(project, id)));
  let cursor: string | undefined;
  do {
    const page = await a.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    // Project names never contain "--", so the part before the first one names the project.
    for (const r of page.repos) if (r.name.split('--')[0] === project && r.name !== project) forks.add(r.name);
    cursor = page.cursor;
  } while (cursor);
  const deleted: string[] = [];
  for (const name of [...forks, project]) if (await a.delete(name)) deleted.push(name);
  return deleted;
}

/** A read-only way into a project's main repository (sync, a reviewer's clone): its remote and a read token. */
export async function mainReadAccess(artifacts: Artifacts | undefined, project: string): Promise<{ remote: string; token: string; expiresAt: string }> {
  const repo = await requireBinding(artifacts).get(project);
  const info = await repo.info();
  const t = await repo.createToken('read', TOKEN_TTL_SECONDS);
  return { remote: info.remote, token: t.plaintext, expiresAt: t.expiresAt };
}

/**
 * Push events. The Artifacts binding has no event-subscription method (its published type offers repos,
 * forks, tokens and reads only), so a subscription is made over the Cloudflare REST API, the same
 * endpoint `wrangler queues subscription create` uses: POST /accounts/:id/event_subscriptions/subscriptions
 * with source `artifacts.repo` (namespace + repoName: Artifacts reports pushes per repository, there is no
 * account-wide push source) and destination the converge-artifacts-events queue. That needs an API token
 * with Event Subscriptions write and Queues read (secret CF_EVENTS_API_TOKEN) and the account id
 * (CF_ACCOUNT_ID); without them nothing is subscribed and the platform's fetch of a worker's fork on
 * status and submit is what records a push (it stays in place either way).
 */
export interface PushEventsConfig {
  accountId: string;
  apiToken: string;
  /** The Artifacts namespace (wrangler.jsonc artifacts[].namespace). */
  namespace: string;
  /** The queue the Worker consumes. */
  queue: string;
}

export const PUSH_QUEUE = 'converge-artifacts-events';
export const subscriptionName = (namespace: string, repo: string) => `converge push ${namespace}/${repo}`;

const CF_API = 'https://api.cloudflare.com/client/v4';
let queueIdCache: { key: string; id: string } | undefined;
let knownSubs: { key: string; names: Set<string>; at: number } | undefined;

async function cfCall(cfg: PushEventsConfig, path: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<any> {
  const r = await fetchFn(`${CF_API}/accounts/${cfg.accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.success === false) {
    const msg = (j?.errors || []).map((e: any) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || `HTTP ${r.status}`;
    throw Object.assign(new Error(`Cloudflare API ${path.split('?')[0]}: ${msg}`), { status: r.status });
  }
  return j;
}

/**
 * Subscribe `repo`'s push events to the queue, once: a subscription with the same name already on the
 * queue is left alone, so calling it again (a retried join, provision's backfill) makes no duplicate.
 * Answers 'created', 'exists', or 'skipped' (no config).
 */
export async function ensurePushSubscription(cfg: PushEventsConfig | undefined, repo: string, fetchFn: typeof fetch = fetch): Promise<'created' | 'exists' | 'skipped'> {
  if (!cfg || !cfg.accountId || !cfg.apiToken) return 'skipped';
  const qkey = `${cfg.accountId}/${cfg.queue}`;
  if (queueIdCache?.key !== qkey) {
    const q = await cfCall(cfg, `/queues?name=${encodeURIComponent(cfg.queue)}&per_page=1`, {}, fetchFn);
    const found = (q.result || []).find((x: any) => x.queue_name === cfg.queue) || (q.result || [])[0];
    if (!found?.queue_id) throw new Error(`queue ${cfg.queue} not found (npm run provision creates it)`);
    queueIdCache = { key: qkey, id: found.queue_id };
  }
  const queueId = queueIdCache.id;
  const name = subscriptionName(cfg.namespace, repo);
  if (knownSubs?.key !== queueId || Date.now() - knownSubs.at > 60_000 || !knownSubs.names.has(name)) {
    const names = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const l = await cfCall(cfg, `/event_subscriptions/subscriptions?queue_id=${queueId}&page=${page}&per_page=100`, {}, fetchFn);
      for (const s of l.result || []) if (s?.name) names.add(s.name);
      const total = l.result_info?.total_pages ?? l.result_info?.totalPages;
      if (!(l.result || []).length || (total && page >= total)) break;
    }
    knownSubs = { key: queueId, names, at: Date.now() };
  }
  if (knownSubs.names.has(name)) return 'exists';
  await cfCall(cfg, '/event_subscriptions/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      name,
      enabled: true,
      source: { type: 'artifacts.repo', namespace: cfg.namespace, repoName: repo },
      destination: { type: 'queues.queue', queue_id: queueId },
      events: ['pushed'],
    }),
  }, fetchFn);
  knownSubs.names.add(name);
  return 'created';
}

/** For tests: forget the cached queue id and subscription names. */
export function resetPushSubscriptionCache(): void { queueIdCache = undefined; knownSubs = undefined; }
