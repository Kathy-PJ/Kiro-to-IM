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
If that path doesn't exist, fall back to Glob with pattern `**/skills/**/kiro-to-im/SKILL.md` and derive the root from the result.

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
- Run `kiro-cli auth status` (or check `~/.kiro/` token files, or AWS creds)
- If not authenticated, guide the user:
  1. `kiro-cli auth login` (opens browser for OAuth)
  2. Wait for confirmation
  3. Verify with `kiro-cli auth status`
- If AWS credentials are detected, inform user and proceed

**Step 1 — Choose channels** (telegram, discord, feishu, qq)

**Step 2 — Collect tokens per channel** (same as Claude-to-IM)

**Step 3 — Kiro settings**
- **kiro-cli path** (optional, auto-detected from PATH)
- **kiro-cli arguments** (default: `acp`)
- **Worker pool size** (default: 4)
- **Working directory** (default: `$CWD`)
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**
1. Show summary (secrets masked)
2. Create directory: `mkdir -p ~/.kiro-to-im/{data,logs,runtime,data/messages}`
3. Write `~/.kiro-to-im/config.env`
4. `chmod 600 ~/.kiro-to-im/config.env`
5. Validate tokens
6. On success: "Setup complete! Run `/kiro-to-im start` to start the bridge."

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
