#!/bin/sh
# Starts as root only to hand the bind-mounted data dir to the unprivileged `bun`
# user (earlier deploys ran as root and left it root-owned), then drops privileges
# for the life of the process.
set -eu

if [ "$(id -u)" = 0 ]; then
	find /app/data ! -user bun -exec chown bun:bun {} +
	exec setpriv --reuid=bun --regid=bun --init-groups --inh-caps=-all -- "$@"
fi

exec "$@"
