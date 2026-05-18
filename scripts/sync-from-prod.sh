#!/usr/bin/env bash
# Pull runtime data (SQLite db + log) from the prod bot to a local dir for
# analysis or backup. Safe to run while the bot is up: the DB is snapshotted
# via SQLite's `VACUUM INTO` (run inside the bot container) before transfer,
# so we get a consistent copy even with WAL writers active.
#
# Usage:
#   ./scripts/sync-from-prod.sh [destination]
#
# Config is read from .deploy.env (same file deploy.sh uses):
#   DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH         required
#   DEPLOY_SSH_PORT, DEPLOY_SSH_OPTS              optional
#
# Override the destination via positional arg or DEST env (default ./data-prod).
# The default matches the data-*/ gitignore pattern, so synced data won't
# accidentally land in a commit.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .deploy.env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.deploy.env
	set +a
fi

: "${DEPLOY_HOST:?set DEPLOY_HOST in .deploy.env or env}"
: "${DEPLOY_USER:?set DEPLOY_USER in .deploy.env or env}"
: "${DEPLOY_PATH:?set DEPLOY_PATH in .deploy.env or env}"

DEST="${1:-${DEST:-./data-prod}}"

ssh_args=()
if [ -n "${DEPLOY_SSH_PORT:-}" ]; then
	ssh_args+=(-p "$DEPLOY_SSH_PORT")
fi
if [ -n "${DEPLOY_SSH_OPTS:-}" ]; then
	# shellcheck disable=SC2206
	ssh_args+=($DEPLOY_SSH_OPTS)
fi

SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
RSYNC_E="ssh ${ssh_args[*]}"

# Refuse to clobber the dev data dir. Compare resolved absolute paths so all
# input shapes (./data, data, /abs/path/data) collapse to the same comparison.
mkdir -p "$DEST"
dest_abs="$(cd "$DEST" && pwd)" || {
	echo "Cannot create or access destination: $DEST" >&2
	exit 1
}
local_data_abs="$(pwd)/data"
if [ "$dest_abs" = "$local_data_abs" ]; then
	echo "Refusing to sync into local dev data dir ($DEST -> $dest_abs)." >&2
	echo "Choose a separate destination, e.g. ./data-prod/." >&2
	exit 1
fi

echo ">>> Source: ${SSH_TARGET}:${DEPLOY_PATH}"
echo ">>> Local:  $DEST"
echo

# Atomic snapshot on the remote, inside the bot container. `VACUUM INTO`
# produces a consistent copy of a WAL-mode db while writers continue.
# The container's /app/data is bind-mounted to $DEPLOY_PATH/data, so the
# snapshot file appears on the host filesystem directly.
echo ">>> Snapshotting ews.db inside bot container..."
# Clear any stale snapshot dir (root-owned, so done inside the container).
ssh "${ssh_args[@]}" "$SSH_TARGET" "cd $DEPLOY_PATH && docker compose exec -T bot rm -rf /app/data/.sync"
# Pipe a tiny `VACUUM INTO` script through ssh into the bot container, write
# it to /tmp inside the container, and run it. `VACUUM INTO` produces a
# consistent copy even with WAL writers active.
ssh "${ssh_args[@]}" "$SSH_TARGET" \
	"cd $DEPLOY_PATH && docker compose exec -T bot sh -c 'cat > /tmp/snapshot-db.ts && bun run /tmp/snapshot-db.ts && rm -f /tmp/snapshot-db.ts'" <<'BUN'
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("/app/data/.sync", { recursive: true });
const db = new Database("/app/data/ews.db", { readonly: true });
db.exec("VACUUM INTO '/app/data/.sync/ews.db'");
db.close();
BUN
size=$(ssh "${ssh_args[@]}" "$SSH_TARGET" "cd $DEPLOY_PATH && docker compose exec -T bot stat -c%s /app/data/.sync/ews.db" | tr -d '\r')
echo "  snapshot: ${size} bytes"

echo ">>> Pulling snapshot db..."
rsync -az -e "$RSYNC_E" "${SSH_TARGET}:${DEPLOY_PATH}/data/.sync/ews.db" "$DEST/ews.db"

echo ">>> Pulling ews.log..."
rsync -az -e "$RSYNC_E" "${SSH_TARGET}:${DEPLOY_PATH}/data/ews.log" "$DEST/ews.log"

echo ">>> Cleaning up snapshot on remote..."
ssh "${ssh_args[@]}" "$SSH_TARGET" "cd $DEPLOY_PATH && docker compose exec -T bot rm -rf /app/data/.sync"

echo
echo "Synced to $DEST"
du -sh "$DEST"/* 2>/dev/null || true
echo
echo "Inspect with:"
echo "  sqlite3 $DEST/ews.db 'SELECT * FROM events ORDER BY id DESC LIMIT 20;'"
echo "  tail -f $DEST/ews.log | jq ."
