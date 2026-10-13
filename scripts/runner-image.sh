#!/usr/bin/env bash
# Build the verification runner's image and push it to Cloudflare's registry, with no Docker:
# scripts/oci.mjs pulls the base image's layers, adds one layer of ours (runner/runner.mjs and a
# static converge-jail, and scripts/check-jail.sh for GET /jail), and pushes the result. Then wrangler.jsonc points the Runner at it.
#
#   scripts/runner-image.sh            (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the env)
#   scripts/runner-image.sh --jail-only    only report the prebuilt converge-jail (local, no Cloudflare)
#
# The base brings what projects' checks run with: node, python3, git, a C toolchain. Add a
# toolchain your projects need by choosing a richer base (RUNNER_BASE).
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${RUNNER_BASE:-docker.io/library/node:22-bookworm}"

# converge-jail for the container: uses the prebuilt static linux/x64 binary in kernel/linux-x64/bin/
JAIL_OUT="${CONVERGE_JAIL_BIN:-kernel/linux-x64/bin/converge-jail}"
if [ ! -f "$JAIL_OUT" ]; then
  echo "converge-jail: binary not found at $JAIL_OUT" >&2
  exit 1
fi
echo "converge-jail: using prebuilt $JAIL_OUT"
[ "${1:-}" = --jail-only ] && { echo "converge-jail: $JAIL_OUT"; exit 0; }
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
TAG="$(git rev-parse --short HEAD)-$(date +%s)"
REF="registry.cloudflare.com/$ACCOUNT/converge-runner:$TAG"

creds="$(npx wrangler containers registries credentials registry.cloudflare.com --push --pull --json --expiration-minutes 30)"
export OCI_USER="$(node -e 'const t=process.argv[1]; console.log(JSON.parse(t.slice(t.indexOf("{"))).username)' "$creds")"
export OCI_PASSWORD="$(node -e 'const t=process.argv[1]; console.log(JSON.parse(t.slice(t.indexOf("{"))).password)' "$creds")"

node scripts/oci.mjs push --base "$BASE" \
  --add runner/runner.mjs:/runner/runner.mjs \
  --add "$JAIL_OUT":/converge-jail \
  --add scripts/check-jail.sh:/check-jail.sh \
  --entrypoint '["node","/runner/runner.mjs"]' \
  --env RUNNER_ROOT=/work --env CONVERGE_JAIL=/converge-jail \
  --to "$REF"

# Point the Runner at the image just pushed, and the Worker's jail check at its tag.
node -e '
const fs = require("fs"); const p = "wrangler.jsonc"; const ref = process.argv[1];
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/"image": "registry\.cloudflare\.com\/[^"]*converge-runner:[^"]*"/, `"image": "${ref}"`));
// And tell the Worker which image that is (worker/runner-image.ts): the jail check runs on a fresh runner per image.
fs.writeFileSync("worker/runner-image.ts", fs.readFileSync("worker/runner-image.ts", "utf8").replace(/RUNNER_IMAGE_TAG = \x27[^\x27]*\x27/, `RUNNER_IMAGE_TAG = \x27${ref.split(":").pop()}\x27`));
' "$REF"
echo "runner image: $REF"
