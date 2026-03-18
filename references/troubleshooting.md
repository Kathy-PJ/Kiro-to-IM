# Troubleshooting

## Bridge won't start

**Symptoms**: `/kiro-to-im start` fails or daemon exits immediately.

**Steps**:

1. Run `/kiro-to-im doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that kiro-cli is available: `kiro-cli --version`
4. Check kiro-cli auth: `kiro-cli auth status`
5. Verify config exists: `ls -la ~/.kiro-to-im/config.env`
6. Check logs for startup errors: `/kiro-to-im logs`

**Common causes**:
- Missing or invalid config.env -- run `/kiro-to-im setup`
- kiro-cli not authenticated -- run `kiro-cli auth login`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/kiro-to-im status`

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid: `/kiro-to-im doctor`
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check logs for incoming message events: `/kiro-to-im logs 200`

## Permission timeout

**Symptoms**: Kiro agent session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs kiro-cli via ACP protocol; if tool approval is required in IM, ensure `KTI_AUTO_APPROVE=true` is set in config.env for unattended operation
2. Check network connectivity if the timeout occurs during API calls
3. Verify kiro-cli auth hasn't expired: `kiro-cli auth status`

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/kiro-to-im status`
2. Restart the daemon to reset memory:
   ```
   /kiro-to-im stop
   /kiro-to-im start
   ```
3. If the issue persists, reduce pool size (`KTI_KIRO_POOL_SIZE`) -- each kiro-cli worker consumes memory
4. Review logs for error loops that may cause memory leaks

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/kiro-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.kiro-to-im/runtime/bridge.pid
   ```
3. Run `/kiro-to-im start` to launch a fresh instance
