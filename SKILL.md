---
name: kiro-to-im
description: |
  Bridge THIS Kiro session to Telegram, Discord, Feishu/Lark, or QQ so the
  user can chat with Kiro AI agent from their phone. Use for: setting up, starting,
  stopping, or diagnosing the kiro-to-im bridge daemon; forwarding Kiro replies to
  a messaging app; any phrase like "kiro-to-im", "bridge", "桥接", "连上飞书",
  "手机上看kiro", "启动后台服务", "诊断", "查看日志", "配置".
  Subcommands: setup, start, stop, status, logs, reconfigure, doctor.
argument-hint: "setup | start | stop | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Kiro-to-IM Bridge Skill

You are managing the Kiro-to-IM bridge.
User data is stored at `~/.kiro-to-im/`.

The skill directory (SKILL_DIR) is at `~/.kiro/skills/kiro-to-im`.
If that path doesn't exist, fall back to Glob with pattern `**/skills/**kiro-to-im/SKILL.md` and derive the root from the result.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples) | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `我想在飞书上用 Kiro`, `帮我连接 Telegram` | setup |
| `start`, `start bridge`, `启动`, `启动桥接` | start |
| `stop`, `stop bridge`, `停止`, `停止桥接` | stop |
| `status`, `bridge status`, `状态`, `运行状态` | status |
| `logs`, `logs 200`, `查看日志` | logs |
| `reconfigure`, `修改配置`, `帮我改一下 token` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `挂了`, `没反应了` | doctor |

## Prerequisites

- **kiro-cli** installed and available in PATH (supports `kiro-cli acp` mode)
- **kiro-cli authenticated** — one of:
  - `kiro-cli auth login` (interactive OAuth — recommended)
  - AWS credentials (env vars or `~/.aws/credentials`)
  - AWS SSO (`aws sso login --profile your-profile`)
- **Node.js >= 20**

## Config check

Before running any subcommand other than `setup`, check if `~/.kiro-to-im/config.env` exists:
- **If NOT:** tell user "No configuration found" and start the `setup` wizard.
- **If exists:** proceed with the requested subcommand.

## Subcommands

### `setup`

Interactive setup wizard. Collect input one field at a time:

**Step 0 — Verify kiro-cli auth**
- Check for kiro-cli SQLite database (platform-specific):
  - macOS: `~/Library/Application Support/kiro-cli/data.sqlite3`
  - Linux: `~/.local/share/kiro-cli/data.sqlite3`
  - Windows: `%APPDATA%/kiro-cli/data.sqlite3`
- Also try `kiro-cli auth status` and check AWS credentials
- If not authenticated, ask user which method they want:
  - **Option A: Interactive login** (desktop with browser)
    1. Run `kiro-cli auth login` (opens browser for OAuth)
    2. Wait for confirmation — tokens stored in SQLite database
    3. Verify with `kiro-cli auth status`
  - **Option B: AWS IAM credentials** (servers, CI)
    1. Collect AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, optional AWS_REGION
    2. Store in config.env as KTI_AWS_ACCESS_KEY_ID etc.
    3. These are forwarded to kiro-cli processes as env vars
  - **Option C: AWS SSO profile** (enterprise)
    1. Collect profile name
    2. Store in config.env as KTI_AWS_PROFILE
    3. Remind user: must run `aws sso login --profile X` before starting bridge
- If AWS credentials are detected in env, inform user and proceed

**Step 1 — Choose channels** (telegram, discord, feishu, qq)

**Step 2 — Collect tokens per channel**

For each enabled channel, collect credentials. **IMPORTANT platform-specific rules:**

- **Telegram**: Collect KTI_TG_BOT_TOKEN (required). Then KTI_TG_CHAT_ID or KTI_TG_ALLOWED_USERS — at least one MUST be set, otherwise the bot rejects all messages.
- **Discord**: Collect KTI_DISCORD_BOT_TOKEN (required). Discord has TWO layers of authorization:
  - **Layer 1 (required)**: KTI_DISCORD_ALLOWED_USERS or KTI_DISCORD_ALLOWED_CHANNELS — at least one MUST be set. This is checked by `isAuthorized()`. If BOTH are empty, ALL messages are rejected regardless of guild settings.
  - **Layer 2 (optional)**: KTI_DISCORD_ALLOWED_GUILDS — additional server-level filter, only checked AFTER layer 1 passes.
  **CRITICAL**: Setting only KTI_DISCORD_ALLOWED_GUILDS is NOT enough. You MUST also set KTI_DISCORD_ALLOWED_USERS (user's Discord ID) or KTI_DISCORD_ALLOWED_CHANNELS (channel ID).
  To get Discord user ID: Enable Developer Mode in Discord settings → right-click user avatar → Copy User ID.
  To get channel ID: Right-click channel name → Copy Channel ID.
  To get guild/server ID: Right-click server name → Copy Server ID.
  **Discord Bot setup requirements**: In Discord Developer Portal → Bot settings, enable: MESSAGE CONTENT INTENT, SERVER MEMBERS INTENT, PRESENCE INTENT.
  **DM (private message) support**: DMs work when KTI_DISCORD_ALLOWED_USERS includes the user's ID. DMs are NOT filtered by guild.
- **Feishu**: Collect KTI_FEISHU_APP_ID and KTI_FEISHU_APP_SECRET (required). KTI_FEISHU_DOMAIN (optional, default: https://open.feishu.cn). KTI_FEISHU_ALLOWED_USERS (optional, empty = allow all).
- **QQ**: Collect KTI_QQ_APP_ID and KTI_QQ_APP_SECRET (required). KTI_QQ_ALLOWED_USERS (optional).

**Step 3 — Kiro settings**
- **kiro-cli path** (optional, auto-detected from PATH)
- **kiro-cli arguments** (default: `acp`)
- **Worker pool size** (default: 4)
- **Working directory** (default: `$CWD`)
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**
1. Show summary (secrets masked)
2. Create directory: `mkdir -p ~/.kiro-to-im/{data,logs,runtime,data/messages}`
3. Write `~/.kiro-to-im/config.env` using **exactly** these key names:
   ```env
   # Required
   KTI_ENABLED_CHANNELS=feishu           # comma-separated: telegram,discord,feishu,qq
   KTI_DEFAULT_WORKDIR=/home/user        # working directory for Kiro agent
   KTI_DEFAULT_MODE=code                 # code, plan, or ask

   # Kiro CLI (all optional)
   KTI_KIRO_CLI_PATH=/usr/local/bin/kiro-cli  # omit to auto-detect
   KTI_KIRO_ARGS=acp                          # kiro-cli arguments
   KTI_KIRO_POOL_SIZE=4                       # worker pool size

   # Kiro Auth (optional — only if using AWS credentials)
   KTI_AWS_ACCESS_KEY_ID=AKIA...
   KTI_AWS_SECRET_ACCESS_KEY=...
   KTI_AWS_REGION=us-east-1
   KTI_AWS_PROFILE=my-profile

   # Telegram
   KTI_TG_BOT_TOKEN=bot123:abc
   KTI_TG_CHAT_ID=99999
   KTI_TG_ALLOWED_USERS=user1,user2

   # Discord (IMPORTANT: ALLOWED_USERS or ALLOWED_CHANNELS is REQUIRED, not optional!)
   KTI_DISCORD_BOT_TOKEN=...
   KTI_DISCORD_ALLOWED_USERS=...           # REQUIRED: user's Discord ID (right-click avatar → Copy User ID)
   KTI_DISCORD_ALLOWED_CHANNELS=...        # Alternative to ALLOWED_USERS
   KTI_DISCORD_ALLOWED_GUILDS=...          # Optional: additional server filter

   # Feishu
   KTI_FEISHU_APP_ID=cli_xxx
   KTI_FEISHU_APP_SECRET=xxx
   KTI_FEISHU_DOMAIN=https://open.feishu.cn
   KTI_FEISHU_ALLOWED_USERS=...

   # QQ
   KTI_QQ_APP_ID=...
   KTI_QQ_APP_SECRET=...
   KTI_QQ_ALLOWED_USERS=...
   KTI_QQ_IMAGE_ENABLED=true
   KTI_QQ_MAX_IMAGE_SIZE=20

   # Permission
   KTI_AUTO_APPROVE=true                 # auto-approve tool calls (no IM confirmation)
   ```
   **IMPORTANT**: Key names must match EXACTLY. Do NOT use shortened names like `KTI_CHANNELS` — use `KTI_ENABLED_CHANNELS`.
4. `chmod 600 ~/.kiro-to-im/config.env`
5. Validate tokens
6. On success: "Setup complete! Run `kiro-to-im start` to start the bridge."

### `start`
Run: `bash "SKILL_DIR/scripts/daemon.sh" start`

### `stop`
Run: `bash "SKILL_DIR/scripts/daemon.sh" stop`

### `status`
Run: `bash "SKILL_DIR/scripts/daemon.sh" status`

### `logs`
Run: `bash "SKILL_DIR/scripts/daemon.sh" logs N` (default N=50)

### `reconfigure`
Read config, show masked settings, collect changes, re-validate, remind to restart.

### `doctor`
Run: `bash "SKILL_DIR/scripts/doctor.sh"`

## Notes

- Always mask secrets in output (show only last 4 characters)
- Always check for config.env before starting the daemon
- The daemon runs as a background Node.js process
- Config persists at `~/.kiro-to-im/config.env`
- ACP communication uses kiro-cli worker pool with consistent hash routing
