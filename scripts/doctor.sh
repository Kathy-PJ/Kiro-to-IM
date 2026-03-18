#!/usr/bin/env bash
set -euo pipefail
KTI_HOME="$HOME/.kiro-to-im"
CONFIG_FILE="$KTI_HOME/config.env"
PID_FILE="$KTI_HOME/runtime/bridge.pid"
LOG_FILE="$KTI_HOME/logs/bridge.log"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

# --- Node.js version ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'))" 0
  else
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'), need >= 20)" 1
  fi
else
  check "Node.js installed" 1
fi

# --- Helper: read a value from config.env ---
get_config() { grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'; }

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo ""

# --- kiro-cli available ---
KIRO_PATH=""
KIRO_VER=""

# 1. Explicit env var / config
KTI_CLI_PATH=$(get_config KTI_KIRO_CLI_PATH 2>/dev/null || true)
if [ -n "$KTI_CLI_PATH" ]; then
  if [ -x "$KTI_CLI_PATH" ]; then
    KIRO_PATH="$KTI_CLI_PATH"
    KIRO_VER=$("$KTI_CLI_PATH" --version 2>/dev/null || echo "unknown")
  else
    KIRO_PATH="$KTI_CLI_PATH"
    KIRO_VER="(not executable)"
  fi
fi

# 2. Search PATH
if [ -z "$KIRO_PATH" ] && command -v kiro-cli &>/dev/null; then
  KIRO_PATH=$(command -v kiro-cli)
  KIRO_VER=$("$KIRO_PATH" --version 2>/dev/null || echo "unknown")
fi

# 3. Common locations
if [ -z "$KIRO_PATH" ]; then
  for cand in \
    "$HOME/.local/bin/kiro-cli" \
    "/usr/local/bin/kiro-cli" \
    "/opt/homebrew/bin/kiro-cli" \
    "$HOME/.npm-global/bin/kiro-cli"; do
    if [ -x "$cand" ]; then
      KIRO_PATH="$cand"
      KIRO_VER=$("$cand" --version 2>/dev/null || echo "unknown")
      break
    fi
  done
fi

if [ -n "$KIRO_PATH" ] && [ -x "$KIRO_PATH" ]; then
  check "kiro-cli available (${KIRO_VER} at ${KIRO_PATH})" 0
else
  check "kiro-cli available (not found — install from https://kiro.dev/)" 1
fi

# --- kiro-cli ACP mode ---
if [ -n "$KIRO_PATH" ] && [ -x "$KIRO_PATH" ]; then
  HELP_TEXT=$("$KIRO_PATH" --help 2>&1 || true)
  if echo "$HELP_TEXT" | grep -qi "acp"; then
    check "kiro-cli supports ACP mode" 0
  else
    check "kiro-cli supports ACP mode (not found in --help output)" 1
  fi
fi

# --- dist/daemon.mjs freshness ---
DAEMON_MJS="$SKILL_DIR/dist/daemon.mjs"
if [ -f "$DAEMON_MJS" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_MJS" 2>/dev/null | head -1)
  if [ -z "$STALE_SRC" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is stale (src changed, run 'npm run build')" 1
  fi
else
  check "dist/daemon.mjs exists (not built — run 'npm run build')" 1
fi

# --- config.env exists ---
if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists ($CONFIG_FILE not found)" 1
fi

# --- config.env permissions ---
if [ -f "$CONFIG_FILE" ]; then
  PERMS=$(stat -f "%Lp" "$CONFIG_FILE" 2>/dev/null || stat -c "%a" "$CONFIG_FILE" 2>/dev/null || echo "unknown")
  if [ "$PERMS" = "600" ]; then
    check "config.env permissions are 600" 0
  else
    check "config.env permissions are 600 (currently $PERMS)" 1
  fi
fi

# --- Load config for channel checks ---
if [ -f "$CONFIG_FILE" ]; then
  KTI_CHANNELS=$(get_config KTI_ENABLED_CHANNELS)

  # --- Telegram ---
  if echo "$KTI_CHANNELS" | grep -q telegram; then
    TG_TOKEN=$(get_config KTI_TG_BOT_TOKEN)
    if [ -n "$TG_TOKEN" ]; then
      TG_RESULT=$(curl -s --max-time 5 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
      if echo "$TG_RESULT" | grep -q '"ok":true'; then
        check "Telegram bot token is valid" 0
      else
        check "Telegram bot token is valid (getMe failed)" 1
      fi
    else
      check "Telegram bot token configured" 1
    fi
  fi

  # --- Feishu ---
  if echo "$KTI_CHANNELS" | grep -q feishu; then
    FS_APP_ID=$(get_config KTI_FEISHU_APP_ID)
    FS_SECRET=$(get_config KTI_FEISHU_APP_SECRET)
    FS_DOMAIN=$(get_config KTI_FEISHU_DOMAIN)
    FS_DOMAIN="${FS_DOMAIN:-https://open.feishu.cn}"
    if [ -n "$FS_APP_ID" ] && [ -n "$FS_SECRET" ]; then
      FEISHU_RESULT=$(curl -s --max-time 5 -X POST "${FS_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FS_APP_ID}\",\"app_secret\":\"${FS_SECRET}\"}" 2>/dev/null || echo '{"code":1}')
      if echo "$FEISHU_RESULT" | grep -q '"code"[[:space:]]*:[[:space:]]*0'; then
        check "Feishu app credentials are valid" 0
      else
        check "Feishu app credentials are valid (token request failed)" 1
      fi
    else
      check "Feishu app credentials configured" 1
    fi
  fi

  # --- QQ ---
  if echo "$KTI_CHANNELS" | grep -q qq; then
    QQ_APP_ID=$(get_config KTI_QQ_APP_ID)
    QQ_APP_SECRET=$(get_config KTI_QQ_APP_SECRET)
    if [ -n "$QQ_APP_ID" ] && [ -n "$QQ_APP_SECRET" ]; then
      QQ_TOKEN_RESULT=$(curl -s --max-time 10 -X POST "https://bots.qq.com/app/getAppAccessToken" \
        -H "Content-Type: application/json" \
        -d "{\"appId\":\"${QQ_APP_ID}\",\"clientSecret\":\"${QQ_APP_SECRET}\"}" 2>/dev/null || echo '{}')
      QQ_ACCESS_TOKEN=$(echo "$QQ_TOKEN_RESULT" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -n "$QQ_ACCESS_TOKEN" ]; then
        check "QQ app credentials are valid (access_token obtained)" 0
        QQ_GW_RESULT=$(curl -s --max-time 10 "https://api.sgroup.qq.com/gateway" \
          -H "Authorization: QQBot ${QQ_ACCESS_TOKEN}" 2>/dev/null || echo '{}')
        if echo "$QQ_GW_RESULT" | grep -q '"url"'; then
          check "QQ gateway is reachable" 0
        else
          check "QQ gateway is reachable (GET /gateway failed)" 1
        fi
      else
        check "QQ app credentials are valid (getAppAccessToken failed)" 1
      fi
    else
      check "QQ app credentials configured" 1
    fi
  fi

  # --- Discord ---
  if echo "$KTI_CHANNELS" | grep -q discord; then
    DC_TOKEN=$(get_config KTI_DISCORD_BOT_TOKEN)
    if [ -n "$DC_TOKEN" ]; then
      if echo "${DC_TOKEN}" | grep -qE '^[A-Za-z0-9_-]{20,}\.'; then
        check "Discord bot token format" 0
      else
        check "Discord bot token format (does not match expected pattern)" 1
      fi
    else
      check "Discord bot token configured" 1
    fi
  fi
fi

# --- Log directory writable ---
LOG_DIR="$KTI_HOME/logs"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable ($LOG_DIR)" 1
fi

# --- PID file consistency ---
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    check "PID file consistent (process $PID is running)" 0
  else
    check "PID file consistent (stale PID $PID, process not running)" 1
  fi
else
  check "PID file consistency (no PID file, OK)" 0
fi

# --- Recent errors in log ---
if [ -f "$LOG_FILE" ]; then
  ERROR_COUNT=$(tail -50 "$LOG_FILE" | grep -ciE 'ERROR|Fatal' || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No recent errors in log (last 50 lines)" 0
  else
    check "No recent errors in log (found $ERROR_COUNT ERROR/Fatal lines)" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  kiro-cli missing      -> install from https://kiro.dev/"
  echo "  dist/daemon.mjs stale -> cd $SKILL_DIR && npm run build"
  echo "  config.env missing    -> run setup wizard"
  echo "  Stale PID file        -> run stop, then start"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
