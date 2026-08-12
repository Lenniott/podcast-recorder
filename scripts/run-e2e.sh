#!/usr/bin/env bash
# Run Playwright e2e for Watch Together guest-control / volume / ducking.
# Needs a free Chrome launch (not inside Cursor's command sandbox).
set -euo pipefail
cd "$(dirname "$0")/.."
export SITE_PASSWORD="${SITE_PASSWORD-}"
export DB_PATH="${DB_PATH:-./data/e2e-rooms.db}"
npm run test:e2e "$@"
