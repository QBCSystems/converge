#!/usr/bin/env bash
# One-time Cloudflare setup for converge, then deploy. Safe to re-run.
#
#   1. secrets  ADMIN_KEY, VIEW_KEY, ENGINE_SHARED_KEY, RECEIPT_SEED (generated once, kept in .env.converge,
#               gitignored; RECEIPT_SEED keeps the receipt signing key across container restarts); they go up
#               with the deploy (--secrets-file), so the Worker never runs without them
#   2. queue    converge-artifacts-events
#   3. pushes   Artifacts reports pushes per repository only (event source artifacts.repo, which needs a
#               namespace and repo name), so each repository gets its own subscription to the queue. With
#               CONVERGE_EVENTS_API_TOKEN set (a Cloudflare API token with Event Subscriptions write and Queues
#               read), it goes up as the Worker secret CF_EVENTS_API_TOKEN (with CF_ACCOUNT_ID), the Worker then
#               subscribes every project repo and agent fork it creates, and this script subscribes the ones
#               that already exist (idempotent: one subscription per repo, by name). Without it, pushes are
#               still recorded: the platform fetches a worker's fork when it calls status or submit.
#   4. runner   when wrangler.jsonc's runner image is not in this account's registry, scripts/runner-image.sh
#               builds and pushes it (it writes the image reference into wrangler.jsonc)
#   5. deploy   the Worker and its Durable Objects, with the secrets. The engine is WebAssembly inside each Project
#               Durable Object (nothing to build here); checks run in the runner containers.
#
# Needs: Node >= 22.6, `npm install` (the pinned wrangler), and `wrangler login` or CLOUDFLARE_API_TOKEN. No Docker.
# CLOUDFLARE_ACCOUNT_ID picks the account (else the one wrangler is signed in to, if it is the only one).
set -euo pipefail
cd "$(dirname "$0")/.."

QUEUE=converge-artifacts-events
KEYS=.env.converge
WR="npx wrangler"   # the version package.json pins

if [ ! -f "$KEYS" ]; then
  umask 077
  {
    echo "ADMIN_KEY=$(openssl rand -hex 24)"
    echo "VIEW_KEY=$(openssl rand -hex 24)"
    echo "ENGINE_SHARED_KEY=$(openssl rand -hex 32)"
    echo "RECEIPT_SEED=$(openssl rand -hex 32)"
  } > "$KEYS"
  echo "generated $KEYS (keep it; it holds your admin and view keys)"
fi
# shellcheck disable=SC1090
. "$KEYS"
# An .env.converge from before RECEIPT_SEED existed gets one now (the same one from then on).
if [ -z "${RECEIPT_SEED:-}" ]; then
  RECEIPT_SEED=$(openssl rand -hex 32)
  (umask 077; echo "RECEIPT_SEED=$RECEIPT_SEED" >> "$KEYS")
fi

echo "== queue"
$WR queues create "$QUEUE" 2>&1 | grep -v 'already exists' || true

echo "== runner image"
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$($WR whoami --json | node -e 'let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>{const a=JSON.parse(t).accounts||[];if(a.length===1)console.log(a[0].id)})')"
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "provision: set CLOUDFLARE_ACCOUNT_ID (wrangler is signed in to no account, or to several)" >&2; exit 1; }
  export CLOUDFLARE_ACCOUNT_ID
fi
if grep -q "\"image\": \"registry\.cloudflare\.com/$CLOUDFLARE_ACCOUNT_ID/converge-runner:" wrangler.jsonc; then
  echo "wrangler.jsonc already points at this account's runner image"
else
  scripts/runner-image.sh
fi

echo "== push events"
if [ -n "${CONVERGE_EVENTS_API_TOKEN:-}" ]; then
  # Into the secrets file (kept, gitignored) so every later deploy carries them; replaced, not duplicated.
  (umask 077; grep -v -E '^(CF_EVENTS_API_TOKEN|CF_ACCOUNT_ID)=' "$KEYS" > "$KEYS.tmp" || true
   { echo "CF_EVENTS_API_TOKEN=$CONVERGE_EVENTS_API_TOKEN"; echo "CF_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID"; } >> "$KEYS.tmp"; mv "$KEYS.tmp" "$KEYS")
  CF_EVENTS_API_TOKEN="$CONVERGE_EVENTS_API_TOKEN"
fi
if [ -n "${CF_EVENTS_API_TOKEN:-}" ]; then
  NS=$(node -e 'const t=require("fs").readFileSync("wrangler.jsonc","utf8");const m=t.match(/"namespace"\s*:\s*"([^"]+)"/);console.log(m?m[1]:"converge")')
  $WR artifacts repos list --namespace "$NS" --json 2>/dev/null > .provision-repos.json || echo "[]" > .provision-repos.json
  CF_EVENTS_API_TOKEN="$CF_EVENTS_API_TOKEN" CF_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" NS="$NS" QUEUE="$QUEUE" \
    node --experimental-strip-types --no-warnings -e '
      import("./worker/artifacts.ts").then(async ({ ensurePushSubscription }) => {
        const j = JSON.parse(require("fs").readFileSync(".provision-repos.json", "utf8") || "[]");
        const repos = (Array.isArray(j) ? j : j.repos || j.result || []).map((r) => r.name).filter(Boolean);
        const cfg = { accountId: process.env.CF_ACCOUNT_ID, apiToken: process.env.CF_EVENTS_API_TOKEN, namespace: process.env.NS, queue: process.env.QUEUE };
        let made = 0, had = 0, failed = 0;
        for (const r of repos) {
          try { (await ensurePushSubscription(cfg, r)) === "created" ? made++ : had++; }
          catch (e) { failed++; console.error(`  ${r}: ${e.message}`); }
        }
        console.log(`push subscriptions: ${made} created, ${had} already there, ${failed} failed, of ${repos.length} repos`);
      });'
  rm -f .provision-repos.json
else
  echo "no CONVERGE_EVENTS_API_TOKEN: no push subscriptions (pushes are recorded on status/submit instead)"
fi

echo "== deploy (with the secrets)"
$WR deploy --secrets-file "$KEYS"

echo
echo "done. Create a project:"
echo "  CONVERGE_API_URL=https://<your worker>.workers.dev ADMIN_KEY=\$ADMIN_KEY node agents/converge.mjs project --project demo"
