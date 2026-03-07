#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/retropi/apps/todo-saas}"
ENV_FILE="$APP_DIR/deploy/pi.env"
DB_NAME="${DB_NAME:-todo_saas}"
DB_USER="${DB_USER:-postgres}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[rotate] missing $ENV_FILE" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  NEW_PASSWORD="$1"
else
  NEW_PASSWORD="$(openssl rand -hex 24)"
  echo "[rotate] generated password: $NEW_PASSWORD"
fi

cd "$APP_DIR"
source "$ENV_FILE"

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "[rotate] POSTGRES_PASSWORD missing in $ENV_FILE" >&2
  exit 1
fi

if [[ "$NEW_PASSWORD" == "$POSTGRES_PASSWORD" ]]; then
  echo "[rotate] new password matches current password; nothing to do"
  exit 0
fi

escaped_password="${NEW_PASSWORD//\'/\'\'}"
tmp_file="$(mktemp)"

cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

echo "[rotate] taking backup before password change"
bash "$APP_DIR/deploy/backup.sh" >/dev/null

echo "[rotate] updating live postgres role password"
docker compose exec -T postgres psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE $DB_USER WITH PASSWORD '$escaped_password';"

echo "[rotate] updating $ENV_FILE"
awk -v new_password="$NEW_PASSWORD" -v db_name="$DB_NAME" -v db_user="$DB_USER" '
  BEGIN {
    database_url = "postgres://" db_user ":" new_password "@postgres:5432/" db_name;
  }
  /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" new_password; next }
  /^DATABASE_URL=/ { print "DATABASE_URL=" database_url; next }
  { print }
' "$ENV_FILE" > "$tmp_file"
mv "$tmp_file" "$ENV_FILE"

echo "[rotate] recreating api with updated env"
docker compose up -d --force-recreate api

echo "[rotate] waiting for api health"
for attempt in $(seq 1 30); do
  if curl -fsS http://localhost/api/health >/dev/null; then
    echo "[rotate] healthy"
    exit 0
  fi
  sleep 2
done

echo "[rotate] health check failed after password rotation" >&2
docker compose ps >&2 || true
docker compose logs --tail=200 >&2 || true
exit 1
