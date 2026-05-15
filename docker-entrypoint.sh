#!/bin/sh
set -e
# Bind-mount ./data от хоста часто принадлежит root (uid 0). Поправим права
# один раз до drop-privileges, чтобы USER node мог писать stats.json.
DATA_DIR=/app/data
NODE_UID=$(id -u node 2>/dev/null || echo 1000)
if [ -d "$DATA_DIR" ] && [ "$(stat -c %u "$DATA_DIR")" != "$NODE_UID" ]; then
    chown -R node:node "$DATA_DIR"
fi
exec su-exec node:node "$@"
