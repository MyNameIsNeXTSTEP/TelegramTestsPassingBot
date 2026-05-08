#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
BACKUP_DIR="${BACKUP_DIR:-/app/data-backups}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-3600}"

backup_once() {
  if [ ! -d "$DATA_DIR" ]; then
    echo "[backup] Data directory '$DATA_DIR' does not exist; skipping backup."
    return
  fi

  timestamp="$(date '+%Y-%m-%d_%H-%M-%S')"
  destination="$BACKUP_DIR/$timestamp"

  mkdir -p "$destination"
  cp -a "$DATA_DIR"/. "$destination"/

  echo "[backup] Snapshot created at $destination"
}

mkdir -p "$BACKUP_DIR"
backup_once

(
  while true; do
    sleep "$BACKUP_INTERVAL_SECONDS"
    backup_once
  done
) &

exec node dist/api/server.js
