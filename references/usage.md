# Usage Guide

This skill works via natural language commands (e.g. `kiro-to-im setup`, "start bridge", "配置", "诊断").

## setup

Interactive wizard that configures the bridge.

```
kiro-to-im setup
```

The wizard will prompt you for:

1. **Kiro authentication** -- Verify kiro-cli is logged in or configure AWS credentials
2. **Channels to enable** -- Enter comma-separated values: `telegram`, `discord`, `feishu`, `qq`
3. **Platform credentials** -- Bot tokens, app IDs, and secrets for each enabled channel
4. **Allowed users** (optional) -- Restrict which users can interact with the bot
5. **Working directory** -- Default project directory for Kiro agent sessions
6. **Kiro settings** -- kiro-cli path, worker pool size, mode (code/plan/ask)

After collecting input, the wizard validates tokens by calling each platform's API and reports results.

Example interaction:

```
> kiro-to-im setup
Checking kiro-cli auth... OK (token file)
Which channels to enable? telegram,discord
Enter Telegram bot token: <your-token>
Enter Discord bot token: <your-token>
Default working directory [/current/dir]: /Users/me/projects
Worker pool size [4]:
Mode [code]:

Validating tokens...
  Telegram: OK (bot @MyBotName)
  Discord: OK (format valid)

Config written to ~/.kiro-to-im/config.env
```

## start

Starts the bridge daemon in the background.

```
kiro-to-im start
```

The daemon process ID is stored in `~/.kiro-to-im/runtime/bridge.pid`. If the daemon is already running, the command reports the existing process.

If startup fails, run `kiro-to-im doctor` to diagnose issues.

## stop

Stops the running bridge daemon.

```
kiro-to-im stop
```

Sends SIGTERM to the daemon process and cleans up the PID file.

## status

Shows whether the daemon is running and basic health information.

```
kiro-to-im status
```

Output includes:
- Running/stopped state
- PID (if running)
- Uptime
- Connected channels

## logs

Shows recent log output from the daemon.

```
kiro-to-im logs        # Last 50 lines (default)
kiro-to-im logs 200    # Last 200 lines
```

Logs are stored in `~/.kiro-to-im/logs/` and are automatically redacted to mask secrets.

## reconfigure

Interactively update the current configuration.

```
kiro-to-im reconfigure
```

Displays current settings with secrets masked, then prompts for changes. After updating, you must restart the daemon for changes to take effect:

```
kiro-to-im stop
kiro-to-im start
```

## doctor

Runs diagnostic checks and reports issues.

```
kiro-to-im doctor
```

Checks performed:
- Node.js version (>= 20 required)
- kiro-cli availability and ACP mode support
- Kiro authentication status
- Config file exists and has correct permissions
- Required tokens are set for enabled channels
- Token validity (API calls)
- QQ credentials and gateway reachability (if QQ enabled)
- Daemon process health
- Log directory writability

### QQ notes

QQ currently supports **C2C private chat only**:
- No inline approval buttons — permissions use text `/perm ...` commands
- No streaming preview
- Image inbound only (no image replies)
- No group/channel support yet
- Required config: `KTI_QQ_APP_ID`, `KTI_QQ_APP_SECRET` (obtain from https://q.qq.com/qqbot/openclaw)
- `KTI_QQ_ALLOWED_USERS` takes `user_openid` values, not QQ numbers
- Set `KTI_QQ_IMAGE_ENABLED=false` if the provider doesn't support image input
