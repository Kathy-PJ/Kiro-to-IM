/**
 * Discord Adapter — discord.js-based message listener and responder.
 *
 * Features:
 *   - Listen for messages via Discord.js client events
 *   - Authorization via ALLOWED_USERS + ALLOWED_CHANNELS (required),
 *     ALLOWED_GUILDS (optional secondary filter)
 *   - Streaming reply via message.edit() (300ms throttle like Feishu)
 *   - Support for message threads
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from 'discord.js';
import { BaseAdapter, type InboundMessage, type ReplyHandle } from './base.js';
import { loadConfig } from '../config.js';

export class DiscordAdapter extends BaseAdapter {
  readonly name = 'discord';

  private botToken: string;
  private allowedUsers?: string[];
  private allowedChannels?: string[];
  private allowedGuilds?: string[];
  private client: Client | null = null;
  private replyMessages = new Map<string, Message>();

  constructor() {
    super();
    const config = loadConfig();
    this.botToken = config.discordBotToken || '';
    this.allowedUsers = config.discordAllowedUsers;
    this.allowedChannels = config.discordAllowedChannels;
    this.allowedGuilds = config.discordAllowedGuilds;
  }

  validateConfig(): string | null {
    if (!this.botToken) return 'Discord BOT_TOKEN is required';
    // Either ALLOWED_USERS or ALLOWED_CHANNELS must be set
    if (
      (!this.allowedUsers || this.allowedUsers.length === 0) &&
      (!this.allowedChannels || this.allowedChannels.length === 0)
    ) {
      return 'Discord requires ALLOWED_USERS or ALLOWED_CHANNELS to be configured';
    }
    return null;
  }

  async start(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on('ready', () => {
      console.log(`[discord] Bot ready: ${this.client?.user?.tag}`);
    });

    this.client.on('messageCreate', (message) => {
      this.handleMessage(message);
    });

    await this.client.login(this.botToken);
    console.log('[discord] Adapter started');
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    console.log('[discord] Adapter stopped');
  }

  private handleMessage(message: Message): void {
    // Skip bot messages
    if (message.author.bot) return;

    // Authorization: check ALLOWED_USERS / ALLOWED_CHANNELS
    const userId = message.author.id;
    const channelId = message.channel.id;
    const guildId = message.guild?.id;

    const userAllowed =
      !this.allowedUsers || this.allowedUsers.length === 0 || this.allowedUsers.includes(userId);
    const channelAllowed =
      !this.allowedChannels || this.allowedChannels.length === 0 || this.allowedChannels.includes(channelId);

    // At least one of (ALLOWED_USERS, ALLOWED_CHANNELS) must match
    if (!userAllowed && !channelAllowed) {
      return;
    }

    // ALLOWED_GUILDS is secondary filter (if set, guild must match)
    if (
      this.allowedGuilds &&
      this.allowedGuilds.length > 0 &&
      guildId &&
      !this.allowedGuilds.includes(guildId)
    ) {
      return;
    }

    // In guild channels, require bot mention or DM
    const isDM = !message.guild;
    const isMentioned = message.mentions.has(this.client!.user!.id);
    if (!isDM && !isMentioned) return;

    // Extract text (remove bot mention)
    let text = message.content;
    if (this.client?.user) {
      text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
    }

    if (!text) return;

    const inbound: InboundMessage = {
      adapter: 'discord',
      chatId: channelId,
      messageId: message.id,
      userId,
      text,
      chatType: isDM ? 'p2p' : 'group',
      rootId: message.reference?.messageId || undefined,
    };

    // Handle image attachments
    const imageAttachments = message.attachments.filter(a =>
      a.contentType?.startsWith('image/'),
    );
    if (imageAttachments.size > 0) {
      inbound.images = imageAttachments.map(a => ({
        key: a.url,
        messageId: message.id,
      }));
    }

    // Handle file attachments
    const fileAttachments = message.attachments.filter(a =>
      !a.contentType?.startsWith('image/'),
    );
    if (fileAttachments.size > 0) {
      inbound.files = fileAttachments.map(a => ({
        key: a.url,
        name: a.name || 'file',
        messageId: message.id,
      }));
    }

    this.emit('message', inbound);
  }

  // ── Reply Methods ──

  async createReply(messageId: string, initialText: string): Promise<ReplyHandle> {
    const channel = await this.findChannel(messageId);
    if (!channel) throw new Error(`Cannot find channel for message ${messageId}`);

    let original: Message | null = null;
    try {
      original = await channel.messages.fetch(messageId);
    } catch { /* message may have been deleted */ }

    let reply: Message;
    if (original) {
      reply = await original.reply(this.truncate(initialText));
    } else {
      reply = await channel.send(this.truncate(initialText));
    }

    this.replyMessages.set(reply.id, reply);
    return { replyId: reply.id };
  }

  async updateReply(handle: ReplyHandle, text: string): Promise<void> {
    const msg = this.replyMessages.get(handle.replyId);
    if (!msg) return;

    try {
      await msg.edit(this.truncate(text));
    } catch (err) {
      // Message may have been deleted
      console.warn(`[discord] Failed to edit message ${handle.replyId}: ${err}`);
    }
  }

  async sendText(chatId: string, text: string, _replyTo?: string): Promise<string> {
    if (!this.client) throw new Error('Discord client not connected');
    const channel = await this.client.channels.fetch(chatId) as TextChannel | null;
    if (!channel?.isTextBased()) throw new Error(`Channel ${chatId} is not text-based`);

    const msg = await (channel as TextChannel).send(this.truncate(text));
    return msg.id;
  }

  // ── Helpers ──

  private async findChannel(messageId: string): Promise<TextChannel | null> {
    if (!this.client) return null;

    // Search through cached channels
    for (const [, channel] of this.client.channels.cache) {
      if (!channel.isTextBased()) continue;
      try {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        if (msg) return channel as TextChannel;
      } catch {
        continue;
      }
    }
    return null;
  }

  private truncate(text: string, maxLen = 2000): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  }
}
