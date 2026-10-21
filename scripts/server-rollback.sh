#!/usr/bin/env bash
# Runs ON the server: puts back the version saved by a deploy.
#   bash /opt/kai/bin/server-rollback.sh            # the latest saved version
#   bash /opt/kai/bin/server-rollback.sh <stamp>    # a specific one (ls /opt/kai/deploy-backups)
#
# Code only — the database stays as it is. (Schema changes are additive, so
# an older version runs on it; a pre-migration snapshot is in the backups.)
set -euo pipefail

APP=/opt/kai/app
ROOT=/opt/kai/deploy-backups
STAMP="${1:-$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tail -1)}"
SOURCE="${ROOT}/${STAMP}"
PORT="$(grep -E '^PORT=' /etc/kai.env | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

if [ ! -d "$SOURCE/dist" ] || [ ! -d "$SOURCE/server" ]; then
    echo "!! no saved version at ${SOURCE}"
    exit 1
fi

echo "-- rolling back to ${STAMP}"
rm -rf "$APP/dist" "$APP/server"
cp -a "$SOURCE/dist" "$SOURCE/server" "$APP/"

if ! cmp -s "$SOURCE/package-lock.json" "$APP/package-lock.json"; then
    cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$APP/"
    (cd "$APP" && npm ci --omit=dev)
fi

chown -R kai:kai "$APP"
systemctl restart kai

for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        echo "== rolled back to ${STAMP}: $(curl -fsS "http://127.0.0.1:${PORT}/api/health")"
        exit 0
    fi
    sleep 1
done

echo "!! still not answering — check: journalctl -u kai -n 50"
exit 1
