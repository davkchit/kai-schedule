#!/usr/bin/env bash
# Deploys the current working copy to the VPS: tests, build, upload, swap,
# restart, health check — and rolls itself back if the new version does not
# come up. Run from the project root in Git Bash:
#
#   bash scripts/deploy.sh root@<server>
#
# The server keeps the previous version in /opt/kai/deploy-backups/<stamp>;
# `bash scripts/rollback.sh root@<server>` puts it back by hand any time.
set -euo pipefail

TARGET="${1:?usage: bash scripts/deploy.sh root@<server>}"
STAMP="$(date +%Y%m%d-%H%M%S)"
PACKAGE="kai-release-${STAMP}.tgz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== tests"
npm test

echo "== build"
npm run build

echo "== package ${PACKAGE}"
tar czf "${WORK}/${PACKAGE}" dist server package.json package-lock.json

echo "== upload"
scp -o BatchMode=yes "${WORK}/${PACKAGE}" scripts/server-deploy.sh scripts/server-rollback.sh "${TARGET}:/tmp/"

echo "== install on the server"
ssh -o BatchMode=yes "$TARGET" "bash /tmp/server-deploy.sh /tmp/${PACKAGE} ${STAMP}"
