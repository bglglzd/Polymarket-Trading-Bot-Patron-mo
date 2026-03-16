#!/bin/bash
# PolyPatronBot VPS Setup Script
# Run this on the VPS as root

set -e

APP_DIR="/opt/polypatronbot-new"

echo "=== PolyPatronBot VPS Setup ==="

# 1. Install Node.js 20 if not present
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "Node.js: $(node -v)"

# 2. Install nginx if not present
if ! command -v nginx &> /dev/null; then
    echo "Installing nginx..."
    apt-get install -y nginx
fi

# 3. Create app directory
mkdir -p "$APP_DIR/.runtime"

# 4. Install dependencies
cd "$APP_DIR"
npm install --production
npm run build

# 5. Setup nginx
cp deploy/nginx-poly.conf /etc/nginx/sites-available/poly.qzx.digital
ln -sf /etc/nginx/sites-available/poly.qzx.digital /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 6. Setup systemd service
cp deploy/polypatronbot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable polypatronbot

# 7. Setup SSL with certbot
if ! command -v certbot &> /dev/null; then
    apt-get install -y certbot python3-certbot-nginx
fi
echo "Run: certbot --nginx -d poly.qzx.digital"

# 8. Create .env if not exists
if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo "Created .env from example - EDIT IT with your API keys!"
fi

echo ""
echo "=== Setup Complete ==="
echo "1. Edit $APP_DIR/.env with your API keys"
echo "2. Start: systemctl start polypatronbot"
echo "3. Logs: journalctl -u polypatronbot -f"
echo "4. Dashboard: https://poly.qzx.digital/dashboard"
