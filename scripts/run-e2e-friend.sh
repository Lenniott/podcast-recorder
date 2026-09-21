#!/usr/bin/env bash
# Runs the three specs that only exercise anything against a server with
# SITE_PASSWORD *and* FRIEND_PASSWORD actually set (wrong_site_password,
# friend_login, friend_room_cap — see each file's own header comment).
# playwright.config.js's shared e2e webServer deliberately blanks
# SITE_PASSWORD for every other spec's isolation/speed, so a normal
# `npm run test:e2e` run skips these three by design — this script starts
# its own server instead, with both passwords and a short-lived
# FRIEND_ROOM_MAX_AGE_HOURS so the cap-expiry case doesn't need a real
# 12-hour wait, and points Playwright at it (`reuseExistingServer`, the
# default outside CI, attaches instead of spawning a second server).
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/ensure-dev-env.sh

vite_port=5173
ws_port=3001

free_listen_port() {
  local port=$1
  local pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [[ -z "$pids" ]] && return 0
  echo "e2e-friend: freeing :$port (pids $(echo "$pids" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
    [[ -z "$pids" ]] && return 0
    sleep 0.2
  done
  echo "e2e-friend: still listening on :$port — SIGKILL"
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

free_listen_port "$vite_port"
free_listen_port "$ws_port"

# A few seconds is enough to prove real expiry-driven unblocking without a
# slow test run. FRIEND_ROOM_MAX_AGE_HOURS_TEST_SECS tells the cap spec how
# long to wait — see friend_room_cap.spec.js's second test.
expiry_secs=5
export SITE_PASSWORD="e2e-host-password"
export FRIEND_PASSWORD="e2e-friend-password"
export FRIEND_ROOM_MAX_AGE_HOURS
FRIEND_ROOM_MAX_AGE_HOURS=$(node -e "console.log($expiry_secs / 3600)")
export FRIEND_ROOM_MAX_AGE_HOURS_TEST_SECS="$expiry_secs"
export DB_PATH="./data/e2e-friend-rooms.db"
rm -f "$DB_PATH"

npm run dev > /tmp/e2e-friend-dev-server.log 2>&1 &
dev_pid=$!

cleanup() {
  kill "$dev_pid" 2>/dev/null || true
  wait "$dev_pid" 2>/dev/null || true
}
trap cleanup EXIT

echo "e2e-friend: waiting for http://localhost:$vite_port ..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$vite_port" > /dev/null 2>&1; then
    echo "e2e-friend: server up"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "e2e-friend: server never came up — log follows"
    cat /tmp/e2e-friend-dev-server.log
    exit 1
  fi
  sleep 1
done

npx playwright test \
  tests/playwright/wrong_site_password.spec.js \
  tests/playwright/friend_login.spec.js \
  tests/playwright/friend_room_cap.spec.js \
  "$@"
