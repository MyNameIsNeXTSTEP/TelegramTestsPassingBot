#!/usr/bin/env bash

set -euo pipefail

# Replace these placeholders directly, or override them via environment vars:
#   SSH_HOST=... SSH_USER=... SSH_KEY_PATH=... REMOTE_APP_DIR=... bash deploy.sh

SSH_HOST="107.172.78.18"
SSH_PORT="22"
SSH_USER="root"
SSH_KEY_PATH="$HOME/.ssh/racknerd_rsa"
SSH_KNOWN_HOSTS_PATH="$HOME/.ssh/known_hosts"

REMOTE_APP_DIR="/opt/telegram-tests"
REMOTE_BRANCH="master"
COMPOSE_FILE="docker-compose.yml"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

require_config() {
  local name="$1"
  local value="$2"

  if [[ -z "$value" || "$value" == *"REPLACE_ME"* || "$value" == "/path/to/repo/on/server" ]]; then
    fail "configure ${name} in deploy.sh before running it"
  fi
}

require_config "SSH_HOST" "$SSH_HOST"
require_config "SSH_USER" "$SSH_USER"
require_config "SSH_KEY_PATH" "$SSH_KEY_PATH"
require_config "REMOTE_APP_DIR" "$REMOTE_APP_DIR"

[[ -f "$SSH_KEY_PATH" ]] || fail "SSH key file not found: $SSH_KEY_PATH"
[[ -f "$SSH_KNOWN_HOSTS_PATH" ]] || fail "known_hosts file not found: $SSH_KNOWN_HOSTS_PATH"

printf 'Deploy target: %s@%s:%s\n' "$SSH_USER" "$SSH_HOST" "$REMOTE_APP_DIR"
printf 'Branch: %s | Compose file: %s\n' "$REMOTE_BRANCH" "$COMPOSE_FILE"

ssh \
  -i "$SSH_KEY_PATH" \
  -p "$SSH_PORT" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$SSH_KNOWN_HOSTS_PATH" \
  "${SSH_USER}@${SSH_HOST}" \
  REMOTE_APP_DIR="$REMOTE_APP_DIR" \
  REMOTE_BRANCH="$REMOTE_BRANCH" \
  COMPOSE_FILE="$COMPOSE_FILE" \
  'bash -s' <<'EOF'
set -euo pipefail

cd "$REMOTE_APP_DIR"

git fetch origin
git checkout "$REMOTE_BRANCH"
git pull --ff-only origin "$REMOTE_BRANCH"

docker compose -f "$COMPOSE_FILE" down --rmi all --remove-orphans
docker compose -f "$COMPOSE_FILE" build --no-cache
docker compose -f "$COMPOSE_FILE" up --force-recreate -d
docker compose -f "$COMPOSE_FILE" ps
EOF
