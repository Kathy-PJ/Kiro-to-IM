# Kiro-to-IM

> **让团队在飞书/Discord/Telegram/QQ 里直接与 Kiro AI 编程助手对话 — 零中间层，需求原汁原味。**

[English](#english) · [架构](#architecture) · [快速开始](#quick-start) · [配置参考](#configuration)

---

## 为什么需要 Kiro-to-IM？

### 问题：中间代理层 ≠ 更好的理解

当前主流方案通过 **Agent-to-Agent 架构**（如 OpenClaw → Kiro CLI）来间接使用 Kiro：

```
人类 → 中间 Agent (Claude) → Kiro CLI → 代码
         ↑ 额外消耗 token
         ↑ 需求经过二次"翻译"
         ↑ 上下文在两个 agent 间割裂
```

这个架构在复杂编排场景下有其价值，但在**大多数日常编程场景**中，中间代理层带来的问题大于收益：

| 痛点 | 说明 |
|---|---|
| **需求失真** | 人的意图经过中间 Agent 重新表述后，细微的上下文和意图可能丢失 |
| **Token 浪费** | 每个请求额外消耗 600–2,000 token 用于"中间翻译"，日积月累成本可观 |
| **响应延迟** | 请求要经过两跳 Agent 处理，延迟翻倍 |
| **调试黑盒** | 出了问题不知道是中间 Agent 的理解偏差还是 Kiro 的执行问题 |
| **权限割裂** | 工具调用的审批流在 Agent 间传递，用户无法直接控制 |

### 解决方案：让人直接和 Kiro 对话

```
人类 → IM (飞书/Discord/TG/QQ) → Kiro-to-IM → Kiro CLI → 代码
         ↑ 零中间层                   ↑ 流式卡片
         ↑ 需求直达                   ↑ 交互式权限
         ↑ 所见即所得                 ↑ 上下文连续
```

**Kiro-to-IM 把 IM 变成 Kiro 的天然终端**，人直接用自然语言描述需求，Kiro 直接执行。没有"中间翻译"，没有 token 浪费，没有理解偏差。

---

## 核心价值

### 🎯 需求直达，零失真
人→Kiro 直连，你怎么说 Kiro 就怎么理解。不再有中间 Agent 的"再创作"。

### 💰 省钱：消除中间层 token 消耗
Agent-to-Agent 模式下每个请求额外消耗 600–2,000 token（~$0.006–$0.018/次）。Kiro-to-IM 完全消除这部分开销 — **只有 Kiro 的成本，没有中间层的 token 税。**

### ⚡ 实时流式反馈
飞书消息卡片 300ms 实时刷新，看 Kiro 一边思考一边写代码。不用等到最终结果才看到反馈。

### 🔐 交互式权限控制
Kiro 要写文件？要执行命令？IM 里弹出确认请求，你回复 `1` 允许或 `2` 拒绝。**人始终在决策环路中。**

### 👥 团队协作天然适配
IM 群里 @bot 即可，整个团队共享同一个 Kiro 实例。对话在 thread 中自动聚合上下文，新消息自动追加到同一会话。

### 🔄 多平台一套部署
飞书、Discord、Telegram、QQ — 四个平台共享同一个 worker pool 和配置。添加新平台只需实现 5 个适配器方法。

---

## 架构

基于 [acp-link](https://github.com/xufanglin/acp-link) 的经过验证的架构，用 TypeScript 完整重写并扩展了多频道支持：

```
                    ┌──────────────────────────────────┐
                    │          IM Platforms             │
                    │  Feishu · Discord · TG · QQ       │
                    └──────────┬───────────────────────┘
                               │ WebSocket / Bot API
                    ┌──────────▼───────────────────────┐
                    │        Adapter Layer              │
                    │  BaseAdapter → FeishuAdapter      │
                    │               DiscordAdapter      │
                    │               TelegramAdapter     │
                    │               QQAdapter           │
                    └──────────┬───────────────────────┘
                               │ InboundMessage
                    ┌──────────▼───────────────────────┐
                    │     Message Router                │
                    │  • spawn per message (no lock)    │
                    │  • FNV-1a hash routing            │
                    │  • interactive permissions        │
                    │  • 300ms throttled card updates   │
                    └──────────┬───────────────────────┘
                               │ ACP Protocol (JSON-RPC / NDJSON)
                    ┌──────────▼───────────────────────┐
                    │     ACP Worker Pool               │
                    │  Worker-0  Worker-1  Worker-N     │
                    │  (kiro-cli processes)             │
                    │  + Dedicated Keepalive Worker     │
                    └──────────────────────────────────┘
```

### 关键设计

| 设计 | 说明 | 来源 |
|---|---|---|
| **Spawn per message** | 每条消息独立处理，无 session lock，并发能力强 | acp-link |
| **FNV-1a hash routing** | 同一 thread 总是路由到同一 worker，保证上下文一致性 | acp-link |
| **reply_card + PATCH** | 先 POST 创建卡片，再 PATCH 300ms 刷新内容，流式体验 | acp-link |
| **双重检查重启** | Worker 崩溃时加锁重启，防止并发重复重启 | acp-link |
| **独立 Keepalive** | 专用 kiro-cli 进程心跳，不占用业务 worker | acp-link |
| **ResourceStore** | SHA256 去重下载 + 本地缓存 + 自动过期清理 | acp-link |
| **适配器抽象** | 新增 IM 平台只需实现 `BaseAdapter` 的 5 个方法 | 原创 |
| **交互式权限** | 权限请求转发到 IM，用户回复数字/关键词确认 | 原创 |
| **多平台共享 pool** | 四个 IM 平台共享同一个 worker pool | 原创 |

---

## 与其他方案对比

|  | Kiro-to-IM v2 | Agent-to-Agent (OpenClaw 方案) | acp-link |
|---|---|---|---|
| **交互模式** | 人 → IM → Kiro（直连） | 人 → Agent → Kiro（代理） | 人 → 飞书 → Kiro（直连） |
| **中间层 token** | ✅ 零 | ❌ 600–2,000/次 | ✅ 零 |
| **需求理解** | 原汁原味 | 经中间 Agent 重新表述 | 原汁原味 |
| **IM 平台** | 飞书 + Discord + TG + QQ | 无 IM | 仅飞书 |
| **流式展示** | ✅ 卡片 300ms 刷新 | 文字进度回调 | ✅ 卡片 300ms 刷新 |
| **权限控制** | ✅ IM 交互式 | 硬编码 allow_once | 硬编码 auto-approve |
| **团队使用** | ✅ 群聊 @bot | 单用户 | ✅ 群聊 @bot |
| **适用场景** | 日常编程、团队协作 | 复杂多 Agent 编排 | 飞书单平台 |

> **总结**：大多数场景下，人直接告诉 Kiro 做什么比让另一个 AI 替你转达更高效。Kiro-to-IM 正是为此而生。

---

## Quick Start

### 前置条件

- **Node.js >= 20**
- **kiro-cli** >= 1.20.0，已运行 `kiro-cli auth login`

### 安装

```bash
git clone https://github.com/Kathy-PJ/Kiro-to-IM.git
cd Kiro-to-IM
npm install && npm run build
```

### 配置

```bash
mkdir -p ~/.kiro-to-im
cat > ~/.kiro-to-im/config.env << 'EOF'
# 必填：启用的频道（逗号分隔）
KTI_ENABLED_CHANNELS=feishu

# 飞书
KTI_FEISHU_APP_ID=cli_xxx
KTI_FEISHU_APP_SECRET=xxx

# 通用
KTI_DEFAULT_WORKDIR=/home/ubuntu/project
KTI_KIRO_POOL_SIZE=2
KTI_AUTO_APPROVE=true
EOF
```

### 启动

```bash
bash scripts/daemon.sh start
bash scripts/daemon.sh logs 50   # 查看日志
bash scripts/daemon.sh status    # 查看状态
```

### systemd 部署（推荐用于服务器）

```bash
bash scripts/install-service.sh
systemctl --user start kiro-to-im
```

---

## Configuration

配置文件：`~/.kiro-to-im/config.env`

### 通用

| Key | Default | Description |
|---|---|---|
| `KTI_ENABLED_CHANNELS` | _(必填)_ | 启用的频道：`feishu,discord,telegram,qq` |
| `KTI_DEFAULT_WORKDIR` | `cwd` | Kiro 工作目录 |
| `KTI_KIRO_CLI_PATH` | 自动检测 | kiro-cli 路径 |
| `KTI_KIRO_ARGS` | `acp` | kiro-cli 启动参数 |
| `KTI_KIRO_POOL_SIZE` | `4` | Worker 进程数 |
| `KTI_AUTO_APPROVE` | `false` | 自动批准权限请求 |

### 飞书

| Key | Description |
|---|---|
| `KTI_FEISHU_APP_ID` | 飞书应用 App ID |
| `KTI_FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `KTI_FEISHU_ALLOWED_USERS` | 允许的用户 open_id（逗号分隔，空=全部） |

### Discord

| Key | Description |
|---|---|
| `KTI_DISCORD_BOT_TOKEN` | Discord Bot Token |
| `KTI_DISCORD_ALLOWED_USERS` | 允许的用户 ID |
| `KTI_DISCORD_ALLOWED_CHANNELS` | 允许的频道 ID |
| `KTI_DISCORD_ALLOWED_GUILDS` | 允许的服务器 ID（可选二级过滤） |

### Telegram

| Key | Description |
|---|---|
| `KTI_TG_BOT_TOKEN` | Telegram Bot Token |
| `KTI_TG_CHAT_ID` | 限制的 Chat ID |
| `KTI_TG_ALLOWED_USERS` | 允许的用户 ID 或 username |

### QQ

| Key | Description |
|---|---|
| `KTI_QQ_APP_ID` | QQ Bot App ID |
| `KTI_QQ_APP_SECRET` | QQ Bot App Secret |

---

## Project Structure

```
src/
  adapters/
    base.ts            # 抽象适配器接口（实现 5 个方法即可接入新平台）
    feishu.ts          # 飞书：WebSocket + protobuf + REST 流式卡片
    discord.ts         # Discord.js 适配器
    telegram.ts        # Telegram 长轮询适配器
    qq.ts              # QQ 开放平台适配器
    index.ts           # 适配器注册表
  acp-client.ts        # ACP 协议客户端（官方 SDK）
  router.ts            # 消息路由器（核心：spawn per message）
  session-map.ts       # 会话映射持久化
  resource-store.ts    # 资源存储（SHA256 去重）
  config.ts            # 配置管理
  logger.ts            # 日志（脱敏 + 轮转）
  mcp-server.ts        # 内嵌 MCP Server（feishu_send_file）
  main.ts              # 入口
scripts/
  daemon.sh            # 守护进程管理
  install-service.sh   # systemd 一键安装
  doctor.sh            # 诊断工具
```

---

## Credits

- 核心架构来自 [acp-link](https://github.com/xufanglin/acp-link) by [@xufanglin](https://github.com/xufanglin)（Rust 版飞书-Kiro 桥接）
- ACP 协议：[Agent Client Protocol](https://github.com/anthropics/agent-client-protocol) by Anthropic

## License

[MIT](LICENSE)

---

<a name="english"></a>

## English

**Kiro-to-IM** bridges Kiro AI coding agent to IM platforms (Feishu/Lark, Discord, Telegram, QQ), letting your team chat with Kiro directly — no intermediate agent, no wasted tokens, no lost context.

**Why not Agent-to-Agent?** In most daily coding scenarios, having another AI "translate" your request to Kiro adds cost (600–2,000 tokens/request), latency, and potential misunderstanding. Kiro-to-IM eliminates the middleman: your words go straight to Kiro.

**Key features:** Multi-platform adapters, 300ms streaming cards, interactive permission control, FNV-1a hash-routed worker pool, SHA256 resource dedup, systemd deployment.

See the Chinese sections above for detailed architecture, configuration, and quick start guide.
