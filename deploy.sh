#!/bin/bash
set -e

# ===== Configuration =====
CTID=100
PVE_IP="10.0.0.254"
SSH_KEY="$HOME/.ssh/id_ed25519"
APP_DIR="/opt/freebuff2api"
SERVICE_NAME="freebuff2api"
# ==========================

echo "=== Freebuff2API Deploy ==="

# 1. Create tarball of the project
echo "[1/4] Creating tarball..."
cd "$(dirname "$0")"
tar czf /tmp/freebuff2api.tar.gz \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='.env' \
  --exclude='*.db' \
  -C .. LXC

# 2. Upload to PVE
echo "[2/4] Uploading to PVE..."
scp -i $SSH_KEY /tmp/freebuff2api.tar.gz root@$PVE_IP:/tmp/freebuff2api.tar.gz

# 3. Deploy to container
echo "[3/4] Deploying to container $CTID..."
ssh -i $SSH_KEY root@$PVE_IP bash -s <<'REMOTE'
set -e
CTID=100
APP_DIR="/opt/freebuff2api"

# Stop service if running
pct exec $CTID -- systemctl stop freebuff2api 2>/dev/null || true

# Create app directory
pct exec $CTID -- mkdir -p $APP_DIR

# Extract tarball
pct exec $CTID -- bash -c "cd /tmp && tar xzf freebuff2api.tar.gz -C / && mv LXC/* $APP_DIR/ 2>/dev/null || mv LXC $APP_DIR/"

# Install dependencies
pct exec $CTID -- bash -c "cd $APP_DIR && npm ci --production 2>/dev/null || npm install --production"

# Create .env if not exists
pct exec $CTID -- bash -c "test -f $APP_DIR/.env || cp $APP_DIR/.env.example $APP_DIR/.env"

# Create systemd service
pct exec $CTID -- bash -c "cat > /etc/systemd/system/freebuff2api.service << 'EOF'
[Unit]
Description=Freebuff2API Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/freebuff2api
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/freebuff2api/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF"

# Enable and start
pct exec $CTID -- systemctl daemon-reload
pct exec $CTID -- systemctl enable freebuff2api
pct exec $CTID -- systemctl start freebuff2api

echo "Service started successfully"
REMOTE

# 4. Verify
echo "[4/4] Verifying..."
sleep 3
ssh -i $SSH_KEY root@$PVE_IP "pct exec $CTID -- systemctl status freebuff2api --no-pager"

echo ""
echo "=== Deploy Complete ==="
echo "Dashboard: http://$PVE_IP:3000 (check container IP)"
echo "Service: pct exec $CTID -- journalctl -u freebuff2api -f"
