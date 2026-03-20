#!/bin/bash
# PolyPatronBot — Full server setup script
# Run as root on a fresh Ubuntu 22.04+ VPS
#
# Usage:
#   scp -r . root@NEW_IP:/opt/polypatronbot-new
#   ssh root@NEW_IP "bash /opt/polypatronbot-new/deploy/setup.sh"

set -euo pipefail

PROJECT_DIR="/opt/polypatronbot-new"
DOMAIN="poly.qzx.digital"  # Change if using a different domain

echo "=== PolyPatronBot Server Setup ==="

# ── 1. System packages ──
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git build-essential

# ── 2. Node.js 20 ──
echo "[2/7] Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node $(node -v), npm $(npm -v)"

# ── 3. Claude Code CLI ──
echo "[3/7] Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code@latest
echo "  Claude $(claude --version 2>/dev/null || echo 'install failed')"
echo ""
echo "  IMPORTANT: You need to authenticate Claude CLI."
echo "  Option A: Copy credentials from your local machine:"
echo "    scp ~/.claude/.credentials.json root@THIS_SERVER:/root/.claude/.credentials.json"
echo "  Option B: Run 'claude auth login' on a machine with a browser,"
echo "    then copy the resulting ~/.claude/.credentials.json to this server."
echo ""

# ── 4. Caddy (reverse proxy + auto HTTPS) ──
echo "[4/7] Installing Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
cp "$PROJECT_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy
echo "  Caddy $(caddy version)"

# ── 5. Project dependencies ──
echo "[5/7] Installing npm dependencies..."
cd "$PROJECT_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── 6. Build TypeScript ──
echo "[6/7] Building TypeScript..."
npx tsc -p tsconfig.json
rm -rf dist/src  # clean stale compiled files

# ── 7. Systemd service ──
echo "[7/7] Setting up systemd service..."
cp "$PROJECT_DIR/deploy/polypatronbot-new.service" /etc/systemd/system/
# Create .env if missing
if [ ! -f "$PROJECT_DIR/.env" ]; then
  if [ -f "$PROJECT_DIR/.env.production" ]; then
    cp "$PROJECT_DIR/.env.production" "$PROJECT_DIR/.env"
    echo "  Copied .env.production → .env"
  else
    echo "  WARNING: No .env file! Copy .env.production to .env and fill in secrets."
  fi
fi
systemctl daemon-reload
systemctl enable polypatronbot-new
systemctl start polypatronbot-new

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Service status:  systemctl status polypatronbot-new"
echo "View logs:       journalctl -u polypatronbot-new -f"
echo "Dashboard:       https://$DOMAIN/dashboard"
echo ""
echo "CHECKLIST:"
echo "  [ ] DNS: Point $DOMAIN A record to this server's IP"
echo "  [ ] Claude credentials: copy ~/.claude/.credentials.json from your local machine"
echo "  [ ] Verify .env has correct secrets (PK_PRIVATE_KEY, CLOB_API_KEY, etc)"
echo "  [ ] Open firewall: ufw allow 22,80,443/tcp && ufw enable"
echo ""
