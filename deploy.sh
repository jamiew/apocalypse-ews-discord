#!/usr/bin/env bash
# Deploy the Apocalypse EWS bot to a remote host via docker-compose.
#
# Usage:
#   cp .deploy.env.example .deploy.env  # one time, fill in host/user/path
#   ./deploy.sh
#
# What it does, in one SSH session on the remote:
#   1. git fetch + git reset --hard ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}
#   2. docker compose build --pull           # refresh base image
#   3. docker compose up -d --build --force-recreate
#   4. docker compose run --rm register      # re-register slash commands
#   5. docker image prune -f                 # reclaim space from stale builds
#   6. docker compose ps + last 30 log lines

set -euo pipefail

cd "$(dirname "$0")"

if [ -f .deploy.env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.deploy.env
	set +a
fi

: "${DEPLOY_HOST:?set DEPLOY_HOST in .deploy.env or env}"
: "${DEPLOY_USER:?set DEPLOY_USER in .deploy.env or env}"
: "${DEPLOY_PATH:?set DEPLOY_PATH in .deploy.env or env}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"

ssh_args=()
if [ -n "${DEPLOY_SSH_PORT:-}" ]; then
	ssh_args+=(-p "$DEPLOY_SSH_PORT")
fi
if [ -n "${DEPLOY_SSH_OPTS:-}" ]; then
	# shellcheck disable=SC2206
	ssh_args+=($DEPLOY_SSH_OPTS)
fi

echo ">>> Deploy target: ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"
echo ">>> Branch:        ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"

# Friendly nudge: warn if local HEAD differs from the deploy branch on the remote git server.
# Skipped silently if not in a git repo or no upstream available.
if git rev-parse --git-dir >/dev/null 2>&1; then
	local_head=$(git rev-parse HEAD 2>/dev/null || echo "")
	remote_head=$(git ls-remote "$DEPLOY_REMOTE" "$DEPLOY_BRANCH" 2>/dev/null | awk '{print $1}' || echo "")
	if [ -n "$local_head" ] && [ -n "$remote_head" ] && [ "$local_head" != "$remote_head" ]; then
		echo "!!! WARNING: local HEAD ($local_head) differs from ${DEPLOY_REMOTE}/${DEPLOY_BRANCH} ($remote_head)"
		echo "    The deploy will use what is on the remote branch, not your local working copy."
		read -r -p "    Continue anyway? [y/N] " ok
		[ "${ok:-N}" = "y" ] || [ "${ok:-N}" = "Y" ] || exit 1
	fi
fi

ssh "${ssh_args[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" \
	DEPLOY_PATH="$DEPLOY_PATH" \
	DEPLOY_REMOTE="$DEPLOY_REMOTE" \
	DEPLOY_BRANCH="$DEPLOY_BRANCH" \
	'bash -s' <<'REMOTE'
set -euo pipefail

cd "$DEPLOY_PATH"

echo ">>> [remote] $(hostname) :: $(pwd)"

if [ ! -f .env ]; then
	echo "!!! .env missing in $DEPLOY_PATH — bot will not boot. Aborting."
	exit 1
fi

echo ">>> git fetch ${DEPLOY_REMOTE} && reset --hard ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
git fetch --prune "$DEPLOY_REMOTE"
git reset --hard "${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
git rev-parse --short HEAD

mkdir -p data

echo ">>> docker compose build --pull"
docker compose build --pull

echo ">>> docker compose up -d --build --force-recreate"
docker compose up -d --build --force-recreate

echo ">>> docker compose run --rm register"
docker compose run --rm register

echo ">>> docker image prune -f"
docker image prune -f >/dev/null

echo ">>> docker compose ps"
docker compose ps

echo ">>> tail bot logs (last 30 lines)"
docker compose logs --tail 30 bot || true
REMOTE

echo ">>> Deploy complete."
echo ">>> Stream logs:  ssh ${DEPLOY_USER}@${DEPLOY_HOST} 'cd ${DEPLOY_PATH} && docker compose logs -f bot'"
