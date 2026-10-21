#!/usr/bin/env bash
# Runs ON the server, started by scripts/deploy.sh:
#   bash /tmp/server-deploy.sh /tmp/kai-release-<stamp>.tgz <stamp>
#
# Keeps the running version in /opt/kai/deploy-backups/<stamp>, swaps in the
# new one, reinstalls server dependencies only when package-lock.json
# changed, restarts the service and waits for /api/health. If the new version
# does not answer, the previous one is put back automatically.
# The database is never touched here (it lives in /opt/kai/data; the app
# snapshots it on start before its own migrations).
set -euo pipefail

PACKAGE="${1:?package path}"
STAMP="${2:?stamp}"
APP=/opt/kai/app
BACKUP="/opt/kai/deploy-backups/${STAMP}"
BIN=/opt/kai/bin
NEW="$(mktemp -d)"
PORT="$(grep -E '^PORT=' /etc/kai.env | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

health() {
    for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# The rollback script stays on the server for later use.
mkdir -p "$BIN"
cp /tmp/server-rollback.sh "$BIN/server-rollback.sh"
chmod 700 "$BIN/server-rollback.sh"

echo "-- saving the current version to ${BACKUP}"
mkdir -p "$BACKUP"
cp -a "$APP/dist" "$APP/server" "$APP/package.json" "$APP/package-lock.json" "$BACKUP/"

tar xzf "$PACKAGE" -C "$NEW"
LOCK_CHANGED=0
cmp -s "$NEW/package-lock.json" "$APP/package-lock.json" || LOCK_CHANGED=1

echo "-- swapping in the new version"
rm -rf "$APP/dist.prev" "$APP/server.prev"
mv "$APP/dist" "$APP/dist.prev"
mv "$APP/server" "$APP/server.prev"
mv "$NEW/dist" "$APP/dist"
mv "$NEW/server" "$APP/server"
cp "$NEW/package.json" "$NEW/package-lock.json" "$APP/"

if [ "$LOCK_CHANGED" = 1 ]; then
    echo "-- package-lock.json changed: npm ci --omit=dev"
    if ! (cd "$APP" && npm ci --omit=dev); then
        echo "!! npm ci failed — putting the previous version back"
        bash "$BIN/server-rollback.sh" "$STAMP"
        exit 1
    fi
fi

chown -R kai:kai "$APP"
systemctl restart kai

if health; then
    echo "== deployed ${STAMP}: $(curl -fsS "http://127.0.0.1:${PORT}/api/health")"
else
    echo "!! the new version does not answer /api/health — rolling back"
    journalctl -u kai -n 30 --no-pager || true
    bash "$BIN/server-rollback.sh" "$STAMP"
    exit 1
fi

rm -rf "$NEW" "$PACKAGE" /tmp/server-deploy.sh /tmp/server-rollback.sh
