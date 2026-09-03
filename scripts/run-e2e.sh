#!/usr/bin/env bash
# Run Playwright e2e. Frees Vite/WS ports first so a leftover `npm run dev`
# cannot be reused (wrong DB, site password, API keys, WS proxy).
set -euo pipefail
cd "$(dirname "$0")/.."

vite_port=5173
ws_port=3001
if [[ -f .env ]]; then
  loaded=$(grep -E '^DEV_WS_PORT=' .env | tail -1 | cut -d= -f2- || true)
  loaded=${loaded%%#*}
  loaded=$(printf '%s' "$loaded" | tr -d '[:space:]"'\''')
  if [[ "$loaded" =~ ^[0-9]+$ ]]; then
    ws_port=$loaded
  fi
fi

free_listen_port() {
  local port=$1
  local pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [[ -z "$pids" ]] && return 0

  echo "e2e: freeing :$port (pids $(echo "$pids" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true

  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
    [[ -z "$pids" ]] && return 0
    sleep 0.2
  done

  echo "e2e: still listening on :$port — SIGKILL"
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

free_listen_port "$vite_port"
free_listen_port "$ws_port"

export SITE_PASSWORD="${SITE_PASSWORD-}"
export DB_PATH="${DB_PATH:-./data/e2e-rooms.db}"
npx playwright test "$@"
