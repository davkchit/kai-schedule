#!/usr/bin/env bash
# Puts the previous version back on the VPS, from your computer:
#   bash scripts/rollback.sh root@<server>            # the latest saved version
#   bash scripts/rollback.sh root@<server> <stamp>    # a specific one
set -euo pipefail

TARGET="${1:?usage: bash scripts/rollback.sh root@<server> [stamp]}"
ssh -o BatchMode=yes "$TARGET" "bash /opt/kai/bin/server-rollback.sh ${2:-}"
