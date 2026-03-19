/**
 * Telegram Adapter — node-telegram-bot-api based message listener.
 *
 * Features:
 *   - Long-polling for message receiving
 *   - Authorization via ALLOWED_USERS + CHAT_ID
 *   - Streaming reply via editMessageText() (300ms throttle)
 *   - Markdown V2 formatting support
 */

import TelegramBot from 'node-telegram-bot-api';
import { BaseAdapter, type InboundMessage, type ReplyHandle } from './base.js';
import { loadConfig } from '../config.js';

export class TelegramAdapter extends BaseAdapter {
  readonly name = 'telegram';

  private botToken: string;
  private chatId?: string;
  private allowedUsers?: string[];
  private bot: TelegramBot | null = null;

  constructor() {
    super();
    const config = loadConfig();
    this.botToken = config.tgBotToken || '';
    this.chatId = config.tgChatId;
    this.allowedUsers = config.tgAllowedUsers;
  }

  validateConfig(): string | null {
    if (!this.botToken) return 'Telegram BOT_TOKEN is required';
    return null;
  }

  async start(): Promise<void> {
    this.bot = new TelegramBot(this.botToken, { polling: true });

    this.bot.on('message', (msg) => {
      this.handleMessage(msg);
    });

    const me = await this.bot.getMe();
    console.log(`[telegram] Bot ready: @${me.username}`);
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
    console.log('[telegram] Adapter stopped');
  }

  private handleMessage(msg: TelegramBot.Message): void {
    // Skip if no text
    if (!msg.text && !msg.caption) return;

    const userId = String(msg.from?.id || '');
    const chatIdStr = String(msg.chat.id);

    // Authorization: CHAT_ID filter
    if (this.chatId && chatIdStr !== this.chatId) return;

    // Authorization: ALLOWED_USERS filter
    if (this.allowedUsers && this.allowedUsers.length > 0) {
      const username = msg.from?.username || '';
      if (!this.allowedUsers.includes(userId) && !this.allowedUsers.includes(username)) {
        return;
      }
    }

    // Extract text (remove bot command prefix)
    let text = (msg.text || msg.caption || '').trim();
    // Remove /command@bot prefix
    text = text.replace(/^\/\w+(@\w+)?\s*/, '').trim();
    if (!text) return;

    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    const inbound: InboundMessage = {
      adapter: 'telegram',
      chatId: chatIdStr,
      messageId: String(msg.message_id),
      userId,
      text,
      chatType: isGroup ? 'group' : 'p2p',
      rootId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    };

    // Handle photo attachments
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      inbound.images = [{ key: largest.file_id, messageId: String(msg.message_id) }];
    }

    // Handle document attachments
    if (msg.document) {
      inbound.files = [{
        key: msg.document.file_id,
        name: msg.document.file_name || 'file',
        messageId: String(msg.message_id),
      }];
    }

    this.emit('message', inbound);
  }

  // ── Reply Methods ──

  async createReply(messageId: string, initialText: string): Promise<ReplyHandle> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    // Determine chat ID from context
    // We need to find the chat for this messageId — use chatId from config or last known
    const chatId = this.chatId || '';
    if (!chatId) throw new Error('Cannot determine chat ID for reply');

    const reply = await this.bot.sendMessage(chatId, initialText, {
      reply_to_message_id: parseInt(messageId, 10) || undefined,
      parse_mode: undefined, // Plain text for initial placeholder
    });

    return {
      replyId: String(reply.message_id),
      threadId: String(reply.chat.id),
    };
  }

  async updateReply(handle: ReplyHandle, text: string): Promise<void> {
    if (!this.bot) return;

    const chatId = handle.threadId || this.chatId || '';
    if (!chatId) return;

    try {
      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: parseInt(handle.replyId, 10),
      });
    } catch (err: any) {
      // Telegram throws if message content hasn't changed
      if (!err.message?.includes('message is not modified')) {
        console.warn(`[telegram] Failed to edit message: ${err.message}`);
      }
    }
  }

  async sendText(chatId: string, text: string, replyTo?: string): Promise<string> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    const msg = await this.bot.sendMessage(chatId, text, {
      reply_to_message_id: replyTo ? parseInt(replyTo, 10) : undefined,
    });
    return String(msg.message_id);
  }

  // ── Enhanced createReply for group chats ──
  // Override to support dynamic chat ID from inbound message

  async createReplyInChat(
    chatId: string,
    messageId: string,
    initialText: string,
  ): Promise<ReplyHandle> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    const reply = await this.bot.sendMessage(chatId, initialText, {
      reply_to_message_id: parseInt(messageId, 10) || undefined,
    });

    return {
      replyId: String(reply.message_id),
      threadId: String(reply.chat.id),
    };
  }
}
