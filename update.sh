#!/bin/sh
# Pull latest main and rebuild the container.
# Safe as `sudo ./update.sh` or `./update.sh` (script sudo's docker if needed).
set -eu
cd "$(dirname "$0")"

git_pull() {
  git pull --ff-only
}

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  # Don't let root own .git after sudo ./update.sh
  su "$SUDO_USER" -c "git -C '$PWD' pull --ff-only"
else
  git_pull
fi

if [ "$(id -u)" -eq 0 ]; then
  docker compose up -d --build
  docker compose ps
  docker compose logs --tail 20 podcast-recorder
else
  sudo docker compose up -d --build
  sudo docker compose ps
  sudo docker compose logs --tail 20 podcast-recorder
fi
