#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/retropi/apps/todo-saas"
BRANCH="main"

cd "$APP_DIR"

echo "[deploy] fetching latest code"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[deploy] rebuilding containers"
docker compose down --remove-orphans
docker compose up --build -d

echo "[deploy] waiting for api health"
for attempt in $(seq 1 30); do
  if curl -fsS http://localhost/api/health >/dev/null; then
    echo "[deploy] healthy"
    exit 0
  fi
  sleep 2
done

echo "[deploy] health check failed" >&2
docker compose ps >&2 || true
docker compose logs --tail=200 >&2 || true
exit 1
