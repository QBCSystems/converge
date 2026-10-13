#!/usr/bin/env bash
# converge-jail held to what it promises: a fenced command works in its own paths and nowhere else,
# cannot reach the network except the ports it was given, and (as root, on the uid fallback) cannot
# read root's files or another process's environment.
#
#   scripts/check-jail.sh [--allow-skip] [path/to/converge-jail]     (default kernel/<os>-<arch>/bin/converge-jail)
#
# Exit 1 if any check fails, and also if any is skipped (not root: the uid-fallback checks; no Landlock or Seatbelt:
# the fence checks) unless --allow-skip. On a Mac (Seatbelt): scripts/check-jail.sh --allow-skip Every check runs on Linux as root, no container needed:
#   sudo scripts/check-jail.sh kernel/linux-x64/bin/converge-jail
# A deployed runner runs it as root itself: GET /jail on the Runner (the image carries it at /check-jail.sh).
set -u
JAIL_DEFAULT="$(dirname "$0")/../kernel/darwin-arm64/bin/converge-jail"
[ "$(uname -s)" = Linux ] && JAIL_DEFAULT="$(dirname "$0")/../kernel/linux-x64/bin/converge-jail"
JAIL="$(realpath "${1:-$JAIL_DEFAULT}")"
BASE="$(mktemp -d /tmp/check-jail.XXXXXX)"
WORK="$BASE/work"; OUT="$BASE/outside"
mkdir -p "$WORK" "$OUT"; chmod 755 "$BASE"; echo s3cret > "$OUT/secret"
fails=0; checks=0; skipped=0
skip() { skipped=$((skipped + $1)); echo "SKIPPED $1 check(s): $2"; }
check() { checks=$((checks + 1)); if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
RO=(--ro /usr --ro /lib --ro /lib64 --ro /bin --ro /etc --ro /proc --ro /dev)
jail() { "$JAIL" --rw "$WORK" --rw /dev/null "${RO[@]}" "$@"; }

echo "mode: $("$JAIL" --mode) (Landlock ABI $("$JAIL" --abi))"
MODE="$("$JAIL" --mode)"
if [ "$MODE" = landlock ] || [ "$MODE" = seatbelt ]; then   # seatbelt: macOS, the same promises
  out=$(cd "$WORK" && jail -- sh -c 'echo inside > made && cat made' 2>&1); [ "$out" = inside ]; check $? "writes inside its read-write paths"
  jail -- sh -c "echo x > $OUT/escaped" 2>/dev/null; [ ! -e "$OUT/escaped" ]; check $? "cannot write outside them"
  out=$(jail -- cat "$OUT/secret" 2>&1); case "$out" in *s3cret*) false;; *) true;; esac; check $? "cannot read outside them"
  out=$(cd "$WORK" && jail -- sh -c "ln -sf $OUT/secret link && cat link" 2>&1); case "$out" in *s3cret*) false;; *) true;; esac; check $? "a symlink out does not reach the file"
  jail -- sh -c 'echo x > /usr/check-jail' 2>/dev/null; [ ! -e /usr/check-jail ]; check $? "read-only paths are not writable"
  jail -- sh -c "sh -c 'echo nested > $OUT/nested'" 2>/dev/null; [ ! -e "$OUT/nested" ]; check $? "a program it starts is fenced too"
  if command -v python3 >/dev/null && [ -x /bin/bash ]; then
    python3 -u -m http.server 0 --bind 127.0.0.1 > "$BASE/http.log" 2>&1 & HTTP=$!
    for _ in $(seq 50); do PORT=$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$BASE/http.log" | head -1); [ -n "$PORT" ] && break; sleep 0.1; done
    out=$(jail -- /bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT && echo CONNECTED" 2>&1); case "$out" in *CONNECTED*) false;; *) true;; esac; check $? "no network unless a port is given"
    out=$(jail --connect "$PORT" -- /bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT && echo CONNECTED" 2>&1); case "$out" in *CONNECTED*) true;; *) false;; esac; check $? "the given port is reachable"
    kill $HTTP 2>/dev/null
  else skip 2 "network checks (need python3 and /bin/bash)"
  fi
else skip 8 "fence checks (the jail is in mode $MODE, not landlock or seatbelt)"
fi

if [ "$(id -u)" = 0 ]; then
  U=61999
  FB=(--fallback-uid $U --fallback-only)
  chown $U:$U "$WORK"; chmod 600 "$OUT/secret"
  [ "$("$JAIL" --mode "${FB[@]}")" = uid ]; check $? "as root with --fallback-uid, the uid fallback applies"
  out=$(cd "$WORK" && jail "${FB[@]}" -- sh -c 'id -u; echo ok > made2' 2>&1); [ "$out" = $U ] && [ -e "$WORK/made2" ]; check $? "it runs as that uid and writes its own dir"
  out=$(jail "${FB[@]}" -- sh -c "echo x > $OUT/uid-escaped; cat $OUT/secret" 2>&1); [ ! -e "$OUT/uid-escaped" ] && case "$out" in *s3cret*) false;; *) true;; esac; check $? "it cannot write elsewhere or read root's private files"
  out=$(jail "${FB[@]}" -- sh -c 'cat /proc/1/environ >/dev/null 2>&1 && echo READ; exit 0' 2>&1); case "$out" in *READ*) false;; *) true;; esac; check $? "it cannot read another process's environment"
else
  skip 4 "uid-fallback checks (need root: sudo $0 $JAIL)"
fi

rm -rf "$BASE"
echo "$checks checks, $fails failed, $skipped SKIPPED"
[ "$fails" = 0 ] || exit 1
if [ "$skipped" -gt 0 ] && [ -z "$ALLOW_SKIP" ]; then echo "SKIPPED checks count as not passed (--allow-skip accepts them)"; exit 2; fi
exit 0
