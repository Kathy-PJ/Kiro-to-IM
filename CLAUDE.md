# CLAUDE.md -- Project Guidelines for Kiro-to-IM

## Overview

Kiro-to-IM bridges Kiro AI agent sessions to IM platforms (Telegram, Discord, Feishu/Lark, QQ)
via the Agent Client Protocol (ACP). It uses the IM adapter framework from claude-to-im with a
custom ACP-based LLM provider that communicates with kiro-cli.

## Architecture

- `src/acp-client.ts` -- TypeScript ACP protocol client (JSON-RPC 2.0 over stdio)
- `src/kiro-provider.ts` -- KiroAcpProvider implementing LLMProvider via ACP worker pool
- `src/main.ts` -- Daemon entry point
- `src/config.ts` -- KTI_ prefixed config (env file based)
- `src/store.ts` -- JSON file BridgeStore
- `src/permission-gateway.ts` -- Async permission bridge
- `src/logger.ts` -- Secret-redacted file logging

## Replying to GitHub Issues

When replying to user-reported issues, include a self-help prompt:

> You can run the following in Kiro to diagnose:
>
> ```
> 1. Read ~/.kiro-to-im/logs/bridge.log (last 50 lines)
> 2. Read ~/.kiro-to-im/config.env to check configuration
> 3. Run bash ~/.kiro/skills/kiro-to-im/scripts/doctor.sh
> 4. Suggest fixes based on logs and config
> ```
