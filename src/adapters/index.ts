/**
 * Adapter registry — self-registration of all adapters.
 *
 * Import this module to register all available adapters.
 */

import { registerAdapter } from './base.js';
import { FeishuAdapter } from './feishu.js';
import { DiscordAdapter } from './discord.js';
import { TelegramAdapter } from './telegram.js';
import { QQAdapter } from './qq.js';

registerAdapter('feishu', () => new FeishuAdapter());
registerAdapter('discord', () => new DiscordAdapter());
registerAdapter('telegram', () => new TelegramAdapter());
registerAdapter('qq', () => new QQAdapter());

export { createAdapter, getRegisteredAdapters } from './base.js';
export type { BaseAdapter, InboundMessage, ReplyHandle } from './base.js';
