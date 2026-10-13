#!/usr/bin/env bash
#   scripts/local.sh [start]     start, print the dashboard URL
#   scripts/local.sh stop        stop it (projects stay in ~/.converge/local)
#   scripts/local.sh status      whether it is up, and its pids
#   scripts/local.sh logs        follow the server's and the helper's output
#   (start and stop refuse while a run's agents are working, so they are not killed: --force overrides)
#

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${CONVERGE_LOCAL_PORT:-8787}"
STATE="${CONVERGE_LOCAL_STATE:-$HOME/.converge-local}"
SERVER_PID="$STATE/server.pid"
HELPER_PID="$STATE/host-agents.pid"
mkdir -p "$STATE" && chmod 700 "$STATE"
# This machine's own settings, if any: lines of NAME=value in $STATE/local.env (an ASQL engine of your own, say:
# AIOS_MYSQL_SOCKET and AIOS_MYSQL_PASS_FILE), exported to everything started here.
[ -f "$STATE/local.env" ] && { set -a; . "$STATE/local.env"; set +a; }

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
# Stops a process started here and everything it started: its process group (nohup + setsid below), and its children by
# PID (the server's per-project converge-engines, also where there is no setsid). The server stops its engines itself on
# SIGTERM (a few seconds: dev-server.mjs); whatever is left after that is killed.
halt() {
  alive "$1" || { rm -f "$1"; return 1; }
  local p kids k; p="$(cat "$1")"
  kids="$(pgrep -P "$p" 2>/dev/null | tr '\n' ' ' || true)"
  kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true
  for k in $kids; do kill -0 "$k" 2>/dev/null && kill -KILL "$k" 2>/dev/null; done
  rm -f "$1"; return 0
}
# A restart or stop kills every agent of a run under way: refuse while one is, unless forced (--force).
busy() { pgrep -f "$ROOT/agents/swarm.mjs" 2>/dev/null | wc -l | tr -d ' '; }
FORCE=""; CMD=""
for a in "$@"; do case "$a" in --force) FORCE=1 ;; *) [ -z "$CMD" ] && CMD="$a" ;; esac; done
CMD="${CMD:-start}"

case "$(uname -s)" in Linux) K_OS=linux ;; Darwin) K_OS=darwin ;; *) K_OS="$(uname -s | tr A-Z a-z)" ;; esac
case "$(uname -m)" in x86_64|amd64) K_ARCH=x64 ;; aarch64|arm64) K_ARCH=arm64 ;; *) K_ARCH="$(uname -m)" ;; esac
KERNEL="${CONVERGE_KERNEL:-kernel/$K_OS-$K_ARCH}"
HAVE_KERNEL=""; [ -f "$KERNEL/VERSION" ] && [ -x "$KERNEL/bin/converge-engine" ] && [ -x "$KERNEL/bin/converge-jail" ] && HAVE_KERNEL=1

case "$CMD" in
  start|stop)
    if [ -z "$FORCE" ] && [ "$(busy)" -gt 0 ]; then
      echo "a run is under way: stopping or restarting now would kill its agents."
      echo "Stop the run from the dashboard first, or pass --force."
      exit 1
    fi ;;
esac

case "$CMD" in
  stop)
    s=0; halt "$SERVER_PID" && s=1; halt "$HELPER_PID" || true
    ASQL_ROOT="${CONVERGE_ASQL_ROOT:-$STATE/asql}"
    for p in $(pgrep -f "aios-server .*--root $ASQL_ROOT( |$)" 2>/dev/null); do kill "$p" 2>/dev/null && s=1; done
    [ "$s" = 1 ] && echo "stopped" || echo "not running"; exit 0 ;;
  status)
    alive "$SERVER_PID" && echo "server: running (pid $(cat "$SERVER_PID")), http://127.0.0.1:$PORT/" || echo "server: not running"
    alive "$HELPER_PID" && echo "host helper: running (pid $(cat "$HELPER_PID"))" || echo "host helper: not running"
    echo "agents working: $(busy)"; exit 0 ;;
  logs) touch "$STATE/server.log" "$STATE/host-agents.log"; exec tail -n 50 -F "$STATE/server.log" "$STATE/host-agents.log" ;;
  start) ;;
  *) echo "usage: scripts/local.sh [start|stop|status|logs] [--force]"; exit 1 ;;
esac

command -v node >/dev/null || { echo "node is needed (22.6 or newer): https://nodejs.org"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
  || { echo "node $(node -v) is too old: converge needs 22.6 or newer (https://nodejs.org)"; exit 1; }
for t in git npm curl; do command -v "$t" >/dev/null || { echo "$t is needed: install it, then run this again"; exit 1; }; done

if ! command -v claude >/dev/null && ! command -v codex >/dev/null && ! command -v gemini >/dev/null && ! command -v cursor-agent >/dev/null; then
  echo "note: no model CLI here (claude, codex, gemini, cursor-agent): add a provider key in the dashboard (Keys), or install one and sign in"
fi
UA_DIR="${UNIVERSAL_AGENT_DIR:-$ROOT/agents/universal}"
[ -f "$UA_DIR/universal-agent.cjs" ] || { echo "no universal-agent.cjs in $UA_DIR: this checkout is incomplete (or set UNIVERSAL_AGENT_DIR)"; exit 1; }
UA_DIR="$(cd "$UA_DIR" && pwd)"


ENGINE_BIN=""; JAIL_BIN=""
if [ -n "${CONVERGE_ENGINE_BIN:-}" ]; then
  ENGINE_BIN="$CONVERGE_ENGINE_BIN"; JAIL_BIN="${CONVERGE_JAIL:-$(dirname "$ENGINE_BIN")/converge-jail}"
  [ -x "$ENGINE_BIN" ] || { echo "CONVERGE_ENGINE_BIN=$ENGINE_BIN is not an executable"; exit 1; }
  echo "engine: $ENGINE_BIN (CONVERGE_ENGINE_BIN)"
elif [ -n "$HAVE_KERNEL" ]; then
  KERNEL="$(cd "$KERNEL" && pwd)"
  ENGINE_BIN="$KERNEL/bin/converge-engine"; JAIL_BIN="${CONVERGE_JAIL:-$KERNEL/bin/converge-jail}"
  echo "engine: on the kernel, prebuilt ($KERNEL: aios $(sed -n 's/^aios=//p' "$KERNEL/VERSION" | cut -c1-12))"
else
  echo "no kernel for this machine at $KERNEL (converge ships kernel/linux-x64, kernel/darwin-arm64 and kernel/win32-x64): this checkout is incomplete"
  exit 1
fi

JAIL_MODE="$("$JAIL_BIN" --mode 2>/dev/null || echo none)"
case "$(uname -s)" in
  Darwin)
    if [ -x /usr/bin/sandbox-exec ] && /usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>/dev/null; then
      echo "sandbox: Seatbelt (sandbox-exec) for agents; checks: converge-jail ($JAIL_MODE)"
    else
      echo "note: /usr/bin/sandbox-exec does not work here: the dashboard works, but runs refuse to start (agents and checks never run unfenced)."
    fi ;;
  *)
    if ! command -v bwrap >/dev/null; then
      echo "note: no bubblewrap here, so runs refuse to start (agents never run unfenced). Install it:"
      echo "  Debian/Ubuntu: sudo apt install bubblewrap   Fedora: sudo dnf install bubblewrap   Arch: sudo pacman -S bubblewrap"
    elif ! bwrap --ro-bind / / --dev /dev --proc /proc --die-with-parent -- /bin/true 2>/dev/null; then
      echo "note: bubblewrap cannot sandbox here (unprivileged user namespaces are off), so runs refuse to start."
    fi
    [ "$JAIL_MODE" = landlock ] || echo "note: converge-jail is in mode $JAIL_MODE (no Landlock ABI 4: Linux 6.7+): checks are refused, never run unfenced."
    ;;
esac


[ -f "$STATE/host-token" ] || ( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' > "$STATE/host-token" )
HOST_TOKEN="$(cat "$STATE/host-token")"
HELPER_PORT="${HOST_AGENTS_PORT:-8786}"
# setsid where there is one (Linux): each process leads its own group, so stop takes its children with it.
DETACH=(); command -v setsid >/dev/null && DETACH=(setsid)

if [ ! -f "$ROOT/node_modules/ws/package.json" ]; then
  echo "installing the server's packages (npm install --omit=dev)"
  ( cd "$ROOT" && npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error ) || { echo "npm install failed: the server cannot start without its packages" >&2; exit 1; }
fi

halt "$SERVER_PID" >/dev/null 2>&1 || true
# Ours is stopped: anything still answering on the port is another process, and a health check would take its answer
# for ours.
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
  echo "port $PORT is in use by another process$(command -v lsof >/dev/null && lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 | sed 's/^/ (pid /;s/$/)/'): stop it, or set CONVERGE_LOCAL_PORT"
  exit 1
fi
halt "$HELPER_PID" >/dev/null 2>&1 || true
if ! alive "$HELPER_PID"; then
  ( umask 077; HOST_AGENTS_TOKEN="$HOST_TOKEN" HOST_AGENTS_PORT="$HELPER_PORT" UNIVERSAL_AGENT="$UA_DIR/universal-agent.cjs" \
      nohup ${DETACH[@]+"${DETACH[@]}"} node "$ROOT/scripts/host-agents.mjs" >> "$STATE/host-agents.log" 2>&1 < /dev/null &
    hp=$!; disown "$hp" 2>/dev/null || true; echo "$hp" > "$HELPER_PID" )
fi

DATA="${CONVERGE_DATA:-}"
if [ -z "$DATA" ]; then
  DATA="$HOME/.converge/local"
  [ ! -d "$DATA" ] && [ -d "$HOME/.converge-local/data" ] && DATA="$HOME/.converge-local/data"
fi
if [ "$DATA" = "$HOME/.converge-local/data" ]; then echo "data: $DATA (from before; the default is now ~/.converge/local: move it there, or set CONVERGE_DATA)"
else echo "data: $DATA"; fi
mkdir -p "$DATA" && chmod 700 "$DATA"
( umask 077
  export CONVERGE_PORT="$PORT" CONVERGE_HOST="${CONVERGE_LOCAL_HOST:-127.0.0.1}" CONVERGE_DATA="$DATA" \
    CONVERGE_ENGINE_BIN="$ENGINE_BIN" CONVERGE_JAIL="$JAIL_BIN" \
    UNIVERSAL_AGENT="$UA_DIR/universal-agent.cjs" HOST_AGENTS_URL="http://127.0.0.1:$HELPER_PORT" HOST_AGENTS_TOKEN="$HOST_TOKEN"
  nohup ${DETACH[@]+"${DETACH[@]}"} node "$ROOT/scripts/dev-server.mjs" >> "$STATE/server.log" 2>&1 < /dev/null &
  sp=$!; disown "$sp" 2>/dev/null || true; echo "$sp" > "$SERVER_PID" )

for _ in $(seq 1 60); do alive "$SERVER_PID" || break; curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
# Up means our server is still running and answering, not that something answers.
{ alive "$SERVER_PID" && curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; } || { echo "the server did not come up:"; tail -n 30 "$STATE/server.log"; exit 1; }
echo "converge (local, with runs): http://127.0.0.1:$PORT/   (logs: scripts/local.sh logs)"
