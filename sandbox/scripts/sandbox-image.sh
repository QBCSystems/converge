#!/usr/bin/env bash
# Build the sandbox image and push it to Cloudflare's registry, with no Docker (scripts/oci.mjs): the base (node,
# git, python, a C toolchain) plus one layer, all of it from this repository: converge's agents (agents/, with the
# universal agent in agents/universal), the linux-x64 kernel (aios-agent-control and aios's runtime, converge-jail,
# aios-git and aios-sh), and the entry script. Every agent of a run is an aios entity exactly as on a machine:
# agents/swarm.mjs --in-aios -> agents/converge.mjs run -> runEntity. Then sandbox/wrangler.jsonc points the
# SandboxBox at it.
#
#   sandbox/scripts/sandbox-image.sh                 build and push (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the env)
#   sandbox/scripts/sandbox-image.sh --rootfs DIR    build the same image and write it out as a root filesystem instead
#                                                    (no Cloudflare): run it under bubblewrap with DIR as /
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
BASE="${SANDBOX_BASE:-docker.io/library/node:22-bookworm}"
ROOTFS=""
[ "${1:-}" = --rootfs ] && { ROOTFS="${2:?--rootfs DIR}"; }

# The container is linux/amd64: its kernel is this repository's kernel/linux-x64, whose binaries are static.
KERNEL="$ROOT/kernel/linux-x64"
for b in aios-agent-control converge-jail git aios-sh; do
  [ -x "$KERNEL/bin/$b" ] || { echo "no $KERNEL/bin/$b: this checkout is incomplete" >&2; exit 1; }
done
[ -f "$KERNEL/runtime/intelligence/runtime/agent.mjs" ] || { echo "no aios runtime in $KERNEL/runtime: this checkout is incomplete" >&2; exit 1; }
[ -f "$ROOT/agents/universal/universal-agent.cjs" ] || { echo "no agents/universal/universal-agent.cjs: this checkout is incomplete" >&2; exit 1; }

# ---- the layer: /app/converge laid out as the repository is, so agents/common.mjs finds the kernel and the agent ----
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/app/converge"
mkdir -p "$APP/agents" "$APP/worker" "$APP/kernel/linux-x64/bin"
cp "$ROOT"/agents/*.mjs "$APP/agents/"
cp -R "$ROOT/agents/universal" "$APP/agents/universal"
cp "$ROOT/worker/connect.mjs" "$APP/worker/"   # agents/converge.mjs imports it
cp "$ROOT/package.json" "$APP/"                # "type": "module" for agents/*.mjs
cp "$KERNEL/VERSION" "$APP/kernel/linux-x64/"
cp -R "$KERNEL/runtime" "$APP/kernel/linux-x64/runtime"
for b in aios-agent-control converge-jail git aios-sh; do cp "$KERNEL/bin/$b" "$APP/kernel/linux-x64/bin/"; done
cp "$ROOT/sandbox/image/entry.mjs" "$STAGE/app/entry.mjs"

IMAGE_ARGS=(--base "$BASE" --add "$STAGE/app:/app" --entrypoint '["node","/app/entry.mjs"]' --env NODE_ENV=production)

if [ -n "$ROOTFS" ]; then
  node sandbox/scripts/oci-rootfs.mjs "${IMAGE_ARGS[@]}" --out "$ROOTFS"
  exit 0
fi

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
TAG="$(git rev-parse --short HEAD)-$(date +%s)"
REF="registry.cloudflare.com/$ACCOUNT/converge-sandbox:$TAG"
creds="$(npx wrangler containers registries credentials registry.cloudflare.com --push --pull --json --expiration-minutes 30)"
export OCI_USER="$(node -e 'const t=process.argv[1]; console.log(JSON.parse(t.slice(t.indexOf("{"))).username)' "$creds")"
export OCI_PASSWORD="$(node -e 'const t=process.argv[1]; console.log(JSON.parse(t.slice(t.indexOf("{"))).password)' "$creds")"
node scripts/oci.mjs push "${IMAGE_ARGS[@]}" --to "$REF"
python3 - "$REF" sandbox/wrangler.jsonc <<'PY'
import re, sys
ref, path = sys.argv[1], sys.argv[2]
s = open(path).read()
s = re.sub(r'"image":\s*"[^"]*"', f'"image": "{ref}"', s, count=1)
open(path, 'w').write(s)
print("sandbox/wrangler.jsonc now points at", ref)
PY
