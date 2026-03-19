import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  // Kiro CLI
  kiroCliPath?: string;
  kiroArgs?: string[];
  kiroPoolSize: number;
  // Kiro Auth — one of these methods:
  //   1. Pre-authenticated: user ran `kiro-cli auth login` beforehand
  //      (tokens in platform-specific SQLite DB, e.g.
  //       macOS: ~/Library/Application Support/kiro-cli/data.sqlite3
  //       Linux: ~/.local/share/kiro-cli/data.sqlite3)
  //   2. AWS credentials: provided here and forwarded to kiro-cli as env vars
  //   3. AWS SSO profile: profile name, user must `aws sso login` beforehand
  kiroAuthMethod?: 'cli' | 'aws-credentials' | 'aws-sso' | 'auto';
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  awsRegion?: string;
  awsProfile?: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
}

export const KTI_HOME = process.env.KTI_HOME || path.join(os.homedir(), ".kiro-to-im");
export const CONFIG_PATH = path.join(KTI_HOME, "config.env");

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  return {
    enabledChannels: splitCsv(env.get("KTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir: env.get("KTI_DEFAULT_WORKDIR") || process.cwd(),
    defaultModel: env.get("KTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("KTI_DEFAULT_MODE") || "code",
    // Kiro CLI
    kiroCliPath: env.get("KTI_KIRO_CLI_PATH") || undefined,
    kiroArgs: splitCsv(env.get("KTI_KIRO_ARGS")) || ["acp"],
    kiroPoolSize: parseInt(env.get("KTI_KIRO_POOL_SIZE") || "4", 10),
    // Kiro Auth
    kiroAuthMethod: (env.get("KTI_KIRO_AUTH_METHOD") || "auto") as Config["kiroAuthMethod"],
    awsAccessKeyId: env.get("KTI_AWS_ACCESS_KEY_ID") || undefined,
    awsSecretAccessKey: env.get("KTI_AWS_SECRET_ACCESS_KEY") || undefined,
    awsSessionToken: env.get("KTI_AWS_SESSION_TOKEN") || undefined,
    awsRegion: env.get("KTI_AWS_REGION") || undefined,
    awsProfile: env.get("KTI_AWS_PROFILE") || undefined,
    // Telegram
    tgBotToken: env.get("KTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("KTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("KTI_TG_ALLOWED_USERS")),
    // Feishu
    feishuAppId: env.get("KTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("KTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("KTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("KTI_FEISHU_ALLOWED_USERS")),
    // Discord
    discordBotToken: env.get("KTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("KTI_DISCORD_ALLOWED_USERS")),
    discordAllowedChannels: splitCsv(env.get("KTI_DISCORD_ALLOWED_CHANNELS")),
    discordAllowedGuilds: splitCsv(env.get("KTI_DISCORD_ALLOWED_GUILDS")),
    // QQ
    qqAppId: env.get("KTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("KTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("KTI_QQ_ALLOWED_USERS")),
    qqImageEnabled: env.has("KTI_QQ_IMAGE_ENABLED")
      ? env.get("KTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("KTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("KTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    autoApprove: env.get("KTI_AUTO_APPROVE") === "true",
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("KTI_ENABLED_CHANNELS", config.enabledChannels.join(","));
  out += formatEnvLine("KTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine("KTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("KTI_DEFAULT_MODE", config.defaultMode);
  // Kiro CLI
  out += formatEnvLine("KTI_KIRO_CLI_PATH", config.kiroCliPath);
  out += formatEnvLine("KTI_KIRO_ARGS", config.kiroArgs?.join(","));
  out += formatEnvLine("KTI_KIRO_POOL_SIZE", String(config.kiroPoolSize));
  // Kiro Auth
  if (config.kiroAuthMethod && config.kiroAuthMethod !== 'auto')
    out += formatEnvLine("KTI_KIRO_AUTH_METHOD", config.kiroAuthMethod);
  out += formatEnvLine("KTI_AWS_ACCESS_KEY_ID", config.awsAccessKeyId);
  out += formatEnvLine("KTI_AWS_SECRET_ACCESS_KEY", config.awsSecretAccessKey);
  out += formatEnvLine("KTI_AWS_SESSION_TOKEN", config.awsSessionToken);
  out += formatEnvLine("KTI_AWS_REGION", config.awsRegion);
  out += formatEnvLine("KTI_AWS_PROFILE", config.awsProfile);
  // Telegram
  out += formatEnvLine("KTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("KTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine("KTI_TG_ALLOWED_USERS", config.tgAllowedUsers?.join(","));
  // Feishu
  out += formatEnvLine("KTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("KTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("KTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine("KTI_FEISHU_ALLOWED_USERS", config.feishuAllowedUsers?.join(","));
  // Discord
  out += formatEnvLine("KTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine("KTI_DISCORD_ALLOWED_USERS", config.discordAllowedUsers?.join(","));
  out += formatEnvLine("KTI_DISCORD_ALLOWED_CHANNELS", config.discordAllowedChannels?.join(","));
  out += formatEnvLine("KTI_DISCORD_ALLOWED_GUILDS", config.discordAllowedGuilds?.join(","));
  // QQ
  out += formatEnvLine("KTI_QQ_APP_ID", config.qqAppId);
  out += formatEnvLine("KTI_QQ_APP_SECRET", config.qqAppSecret);
  out += formatEnvLine("KTI_QQ_ALLOWED_USERS", config.qqAllowedUsers?.join(","));
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("KTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("KTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));
  if (config.autoApprove)
    out += formatEnvLine("KTI_AUTO_APPROVE", "true");

  fs.mkdirSync(KTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  // Telegram
  m.set("bridge_telegram_enabled", config.enabledChannels.includes("telegram") ? "true" : "false");
  if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers) m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);

  // Discord
  m.set("bridge_discord_enabled", config.enabledChannels.includes("discord") ? "true" : "false");
  if (config.discordBotToken) m.set("bridge_discord_bot_token", config.discordBotToken);
  if (config.discordAllowedUsers) m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
  if (config.discordAllowedChannels) m.set("bridge_discord_allowed_channels", config.discordAllowedChannels.join(","));
  if (config.discordAllowedGuilds) m.set("bridge_discord_allowed_guilds", config.discordAllowedGuilds.join(","));

  // Feishu
  m.set("bridge_feishu_enabled", config.enabledChannels.includes("feishu") ? "true" : "false");
  if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
  if (config.feishuAppSecret) m.set("bridge_feishu_app_secret", config.feishuAppSecret);
  if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
  if (config.feishuAllowedUsers) m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));

  // QQ
  m.set("bridge_qq_enabled", config.enabledChannels.includes("qq") ? "true" : "false");
  if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
  if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
  if (config.qqAllowedUsers) m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
  if (config.qqImageEnabled !== undefined) m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined) m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));

  // Defaults
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  m.set("bridge_default_mode", config.defaultMode);

  return m;
}
