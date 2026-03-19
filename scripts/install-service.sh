#!/usr/bin/env bash
# Install kiro-to-im as a systemd user service with auto-restart.
# Like acp-link's systemd integration.
#
# Usage: bash scripts/install-service.sh
#
# Prerequisites:
#   - loginctl enable-linger $USER  (persist service across reboots)
#   - node >= 20
#   - kiro-cli auth login

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KTI_HOME="${KTI_HOME:-$HOME/.kiro-to-im}"
SERVICE_NAME="kiro-to-im"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"
NODE_BIN="$(which node 2>/dev/null || echo '/usr/bin/node')"

echo "=== kiro-to-im systemd service installer ==="
echo "Skill directory: $SKILL_DIR"
echo "KTI_HOME:        $KTI_HOME"
echo "Node:            $NODE_BIN"
echo ""

# Ensure build is up to date
if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$SKILL_DIR" && npm run build)
fi

# Ensure config exists
if [ ! -f "$KTI_HOME/config.env" ]; then
  echo "WARNING: $KTI_HOME/config.env does not exist."
  echo "  Create it before starting the service."
  echo "  See README for configuration keys."
  echo ""
fi

# Create service directory
mkdir -p "$SERVICE_DIR"

# Write systemd unit file
cat > "$SERVICE_FILE" << UNIT
[Unit]
Description=Kiro-to-IM Bridge Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${SKILL_DIR}/dist/daemon.mjs
WorkingDirectory=${SKILL_DIR}
Restart=on-failure
RestartSec=5
Environment=KTI_HOME=${KTI_HOME}
EnvironmentFile=-${KTI_HOME}/config.env
StandardOutput=append:${KTI_HOME}/logs/bridge.log
StandardError=append:${KTI_HOME}/logs/bridge.log

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT

echo "Service file written: $SERVICE_FILE"

# Reload systemd and enable service
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Commands:"
echo "  systemctl --user start  $SERVICE_NAME    # Start service"
echo "  systemctl --user stop   $SERVICE_NAME    # Stop service"
echo "  systemctl --user status $SERVICE_NAME    # Check status"
echo "  journalctl --user -u $SERVICE_NAME -f    # View logs"
echo ""
echo "IMPORTANT: Run this to persist across reboots:"
echo "  sudo loginctl enable-linger $USER"
echo ""

# Check linger status
if command -v loginctl >/dev/null 2>&1; then
  if loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    echo "✓ Linger is enabled — service will persist across reboots."
  else
    echo "⚠ Linger is NOT enabled. Run: sudo loginctl enable-linger $USER"
  fi
fi
