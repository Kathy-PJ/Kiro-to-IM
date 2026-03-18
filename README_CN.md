# Kiro-to-IM

将 Kiro AI 智能体桥接到 IM 平台 -- 通过 Telegram、Discord、飞书/Lark 或 QQ 与 Kiro 对话。

[English](README.md)

> 基于 [Agent Client Protocol (ACP)](https://github.com/anthropics/agent-client-protocol) 和 [kiro-cli](https://kiro.dev/)。IM 适配器来自 [claude-to-im](https://github.com/op7418/claude-to-im)。

---

## 工作原理

本项目运行一个后台守护进程，通过 ACP 协议将你的 IM Bot 连接到 Kiro AI 智能体。IM 消息被转发到 kiro-cli，响应（包括工具调用、流式文本）被回传到聊天中。

```
你 (Telegram/Discord/飞书/QQ)
  | Bot API
后台守护进程 (Node.js)
  | ACP 协议 (JSON-RPC over stdio)
kiro-cli 进程池 -> 读写你的代码库
```

## 功能特性

- **四个 IM 平台** -- Telegram、Discord、飞书/Lark、QQ
- **ACP 进程池** -- 多个 kiro-cli 进程，一致性哈希路由
- **自动重启** -- 崩溃的 worker 自动重启
- **保活心跳** -- 定期心跳防止认证 token 过期
- **交互式配置** -- 引导式向导逐步收集 token
- **权限控制** -- 工具调用需通过内联按钮或文本命令审批
- **流式预览** -- 实时查看 Kiro 的响应（Telegram & Discord）
- **会话持久化** -- 会话在守护进程重启后保持
- **安全保护** -- Token 以 chmod 600 存储，日志自动脱敏

## 前置要求

- **Node.js >= 20**
- **kiro-cli** -- 已安装并支持 `kiro-cli acp` 模式

## 安装

```bash
git clone https://github.com/Kathy-PJ/Kiro-to-IM.git ~/.kiro/skills/kiro-to-im
cd ~/.kiro/skills/kiro-to-im
npm install && npm run build
```

## 快速开始

### 1. 配置
```
/kiro-to-im setup
```

### 2. 启动
```
/kiro-to-im start
```

### 3. 聊天
打开你的 IM 应用，向 Bot 发送消息，Kiro 就会回复。

## 命令

| 命令 | 说明 |
|---|---|
| `/kiro-to-im setup` | 交互式配置向导 |
| `/kiro-to-im start` | 启动桥接守护进程 |
| `/kiro-to-im stop` | 停止守护进程 |
| `/kiro-to-im status` | 查看运行状态 |
| `/kiro-to-im logs [N]` | 查看最近 N 行日志 |
| `/kiro-to-im reconfigure` | 修改配置 |
| `/kiro-to-im doctor` | 诊断问题 |

## Kiro 特有配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `KTI_KIRO_CLI_PATH` | 自动检测 | kiro-cli 可执行文件路径 |
| `KTI_KIRO_ARGS` | `acp` | kiro-cli 启动参数 |
| `KTI_KIRO_POOL_SIZE` | `4` | kiro-cli 工作进程池大小 |
| `KTI_AUTO_APPROVE` | `false` | 自动批准工具权限请求 |

## 致谢

- IM 适配器框架：[claude-to-im](https://github.com/op7418/claude-to-im) by [@op7418](https://github.com/op7418)
- ACP 协议设计参考：[acp-link](https://github.com/xufanglin/acp-link) by [@xufanglin](https://github.com/xufanglin)

## 许可证

[MIT](LICENSE)
