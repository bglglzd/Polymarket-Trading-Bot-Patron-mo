#!/bin/bash
# PolyPatronBot — Quick deploy (code update only, no system setup)
# Run from your local machine:
#   bash deploy/deploy.sh root@SERVER_IP
#
# This copies source, compiles, and restarts the service.

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: bash deploy/deploy.sh root@SERVER_IP"
  echo "Example: bash deploy/deploy.sh root@65.109.216.157"
  exit 1
fi

TARGET="$1"
REMOTE_DIR="/opt/polypatronbot-new"

echo "=== Deploying to $TARGET ==="

echo "[1/4] Copying source files..."
scp -r src/ "$TARGET:$REMOTE_DIR/src/"
scp config.yaml "$TARGET:$REMOTE_DIR/config.yaml"
scp package.json "$TARGET:$REMOTE_DIR/package.json"
scp tsconfig.json "$TARGET:$REMOTE_DIR/tsconfig.json"

echo "[2/4] Compiling TypeScript..."
ssh "$TARGET" "cd $REMOTE_DIR && npx tsc -p tsconfig.json && rm -rf dist/src"

echo "[3/4] Restarting service..."
ssh "$TARGET" "systemctl restart polypatronbot-new"

echo "[4/4] Checking status..."
sleep 3
ssh "$TARGET" "systemctl is-active polypatronbot-new && journalctl -u polypatronbot-new --no-pager -n 5 --output=short-iso"

echo ""
echo "=== Deploy complete ==="
