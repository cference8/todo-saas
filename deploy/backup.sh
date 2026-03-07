#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/retropi/apps/todo-saas}"
BACKUP_DIR="${BACKUP_DIR:-/home/retropi/backups/todo-saas}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_NAME="${DB_NAME:-todo_saas}"
DB_USER="${DB_USER:-postgres}"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_DIR/${DB_NAME}-${timestamp}.sql.gz"
latest_link="$BACKUP_DIR/latest.sql.gz"

echo "[backup] writing $backup_file"
docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip -9 > "$backup_file"
ln -sfn "$backup_file" "$latest_link"

find "$BACKUP_DIR" -type f -name '*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "[backup] complete"
echo "$backup_file"
