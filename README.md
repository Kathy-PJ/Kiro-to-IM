# Kiro-to-IM

Bridge Kiro AI agent to IM platforms -- chat with Kiro from Telegram, Discord, Feishu/Lark, or QQ.

[Chinese](README_CN.md)

> Powered by the [Agent Client Protocol (ACP)](https://github.com/anthropics/agent-client-protocol) and [kiro-cli](https://kiro.dev/). IM adapters from [claude-to-im](https://github.com/op7418/claude-to-im).

---

## How It Works

This project runs a background daemon that connects your IM bots to Kiro AI agent sessions via the ACP protocol. Messages from IM are forwarded to kiro-cli, and responses (including tool use, streaming text) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ)
  | Bot API
Background Daemon (Node.js)
  | ACP Protocol (JSON-RPC over stdio)
kiro-cli worker pool -> reads/writes your codebase
```

## Features

- **Four IM platforms** -- Telegram, Discord, Feishu/Lark, QQ
- **ACP worker pool** -- Multiple kiro-cli processes with consistent hash routing
- **Auto-restart** -- Crashed workers are automatically restarted
- **Keepalive** -- Periodic heartbeats prevent auth token expiration
- **Interactive setup** -- Guided wizard collects tokens step-by-step
- **Permission control** -- Tool calls require approval via inline buttons or text commands
- **Streaming preview** -- See Kiro's response as it types (Telegram & Discord)
- **Session persistence** -- Conversations survive daemon restarts
- **Secret protection** -- Tokens stored with `chmod 600`, auto-redacted in logs

## Prerequisites

- **Node.js >= 20**
- **kiro-cli** -- installed and supports `kiro-cli acp` mode ([kiro.dev](https://kiro.dev/))

## Installation

### Git clone

```bash
git clone https://github.com/Kathy-PJ/Kiro-to-IM.git ~/.kiro/skills/kiro-to-im
cd ~/.kiro/skills/kiro-to-im
npm install && npm run build
```

## Quick Start

### 1. Setup

```
kiro-to-im setup
```

The wizard will guide you through:
1. **Choose channels** -- Telegram, Discord, Feishu, QQ
2. **Enter credentials** -- step-by-step with inline guidance
3. **Configure Kiro** -- kiro-cli path, pool size, working directory
4. **Validate** -- tokens verified against platform APIs

### 2. Start

```
kiro-to-im start
```

### 3. Chat

Open your IM app and send a message to your bot. Kiro will respond.

## Commands

| Command | Description |
|---|---|
| `kiro-to-im setup` | Interactive setup wizard |
| `kiro-to-im start` | Start the bridge daemon |
| `kiro-to-im stop` | Stop the bridge daemon |
| `kiro-to-im status` | Show daemon status |
| `kiro-to-im logs [N]` | Show last N log lines (default 50) |
| `kiro-to-im reconfigure` | Update config interactively |
| `kiro-to-im doctor` | Diagnose issues |

## Configuration

Config file: `~/.kiro-to-im/config.env`

See `config.env.example` for all options. Key Kiro-specific settings:

| Setting | Default | Description |
|---|---|---|
| `KTI_KIRO_CLI_PATH` | auto-detect | Path to kiro-cli executable |
| `KTI_KIRO_ARGS` | `acp` | Arguments for kiro-cli |
| `KTI_KIRO_POOL_SIZE` | `4` | Number of kiro-cli worker processes |
| `KTI_AUTO_APPROVE` | `false` | Auto-approve tool permissions |

## Architecture

```
~/.kiro-to-im/
  config.env              <- Credentials & settings (chmod 600)
  data/                   <- Persistent JSON storage
    sessions.json
    bindings.json
    permissions.json
    messages/             <- Per-session message history
  logs/
    bridge.log            <- Auto-rotated, secrets redacted
  runtime/
    bridge.pid            <- Daemon PID file
    status.json           <- Current status
```

### Key components

| Component | Role |
|---|---|
| `src/acp-client.ts` | ACP protocol client (JSON-RPC 2.0 over stdio) |
| `src/kiro-provider.ts` | KiroAcpProvider -- worker pool with hash routing |
| `src/main.ts` | Daemon entry point |
| `src/config.ts` | Load/save config.env with KTI_ prefix |
| `src/store.ts` | JSON file BridgeStore (write-through cache) |
| `src/permission-gateway.ts` | Async bridge: ACP permissions <-> IM buttons |
| `src/logger.ts` | Secret-redacted file logging with rotation |

### ACP Worker Pool

```
IM Message -> hash(session_id) -> Worker-N -> kiro-cli process
                                     |
                                     v
                              ACP Protocol (stdio)
                                     |
                                     v
                              Streaming response -> IM reply
```

- Requests routed to fixed workers via FNV-1a hash on session ID
- Same session always goes to same kiro-cli process (session affinity)
- Crashed workers auto-restart with retry
- Keepalive heartbeats every 6 hours

## Credits

- IM adapter framework: [claude-to-im](https://github.com/op7418/claude-to-im) by [@op7418](https://github.com/op7418)
- ACP protocol design inspired by [acp-link](https://github.com/xufanglin/acp-link) by [@xufanglin](https://github.com/xufanglin)

## License

[MIT](LICENSE)
