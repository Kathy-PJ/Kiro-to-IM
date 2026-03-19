/**
 * QQ Adapter — QQ Bot SDK based message listener.
 *
 * Features:
 *   - WebSocket for message receiving (QQ Open Platform)
 *   - Authorization via ALLOWED_USERS
 *   - Text message reply and edit
 *
 * Note: QQ Bot SDK is still evolving. This adapter provides the basic
 * structure and can be extended as the SDK matures.
 */

import { BaseAdapter, type InboundMessage, type ReplyHandle } from './base.js';
import { loadConfig } from '../config.js';

// QQ API base
const QQ_API_BASE = 'https://api.sgroup.qq.com';

interface QQTokenCache {
  token: string;
  expiresAt: number;
}

export class QQAdapter extends BaseAdapter {
  readonly name = 'qq';

  private appId: string;
  private appSecret: string;
  private allowedUsers?: string[];
  private tokenCache: QQTokenCache | null = null;
  private running = false;
  private ws: any = null;

  constructor() {
    super();
    const config = loadConfig();
    this.appId = config.qqAppId || '';
    this.appSecret = config.qqAppSecret || '';
    this.allowedUsers = config.qqAllowedUsers;
  }

  validateConfig(): string | null {
    if (!this.appId) return 'QQ APP_ID is required';
    if (!this.appSecret) return 'QQ APP_SECRET is required';
    return null;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[qq] Starting QQ adapter...');

    // Get access token
    try {
      await this.getAccessToken();
      console.log('[qq] Access token obtained');
    } catch (err) {
      console.error(`[qq] Failed to get access token: ${err}`);
      throw err;
    }

    // Start WebSocket connection for receiving messages
    this.connectLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log('[qq] Adapter stopped');
  }

  private async connectLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectWs();
      } catch (err) {
        console.error(`[qq] WS error: ${err instanceof Error ? err.message : err}, reconnecting in 5s...`);
      }
      if (this.running) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async connectWs(): Promise<void> {
    // Get WebSocket gateway URL
    const token = await this.getAccessToken();
    const resp = await fetch(`${QQ_API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    const data = await resp.json() as any;
    const gatewayUrl = data.url;
    if (!gatewayUrl) throw new Error('Failed to get QQ WebSocket gateway URL');

    console.log(`[qq] Connecting to WebSocket: ${gatewayUrl}`);

    // Dynamic import ws for QQ adapter too
    const { default: WebSocket } = await import('ws');

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      let heartbeatTimer: NodeJS.Timeout | null = null;
      let lastSeq: number | null = null;

      ws.on('open', () => {
        console.log('[qq] WS connected');
      });

      ws.on('message', (rawData: Buffer) => {
        try {
          const payload = JSON.parse(rawData.toString('utf-8'));
          const op = payload.op;

          // op=10: Hello → send Identify
          if (op === 10) {
            const heartbeatIntervalMs = payload.d?.heartbeat_interval || 45000;
            // Send Identify
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${token}`,
                intents: 0 | (1 << 25) | (1 << 30), // PUBLIC_GUILD_MESSAGES | C2C_MESSAGE_CREATE
                shard: [0, 1],
              },
            }));
            // Start heartbeat
            heartbeatTimer = setInterval(() => {
              ws.send(JSON.stringify({ op: 1, d: lastSeq }));
            }, heartbeatIntervalMs);
          }

          // op=11: Heartbeat ACK
          // op=0: Dispatch (event)
          if (op === 0) {
            if (payload.s) lastSeq = payload.s;
            this.handleEvent(payload.t, payload.d);
          }

          // op=7: Reconnect
          if (op === 7) {
            console.warn('[qq] Server requested reconnect');
            ws.close();
          }
        } catch (err) {
          console.error(`[qq] WS message parse error: ${err}`);
        }
      });

      ws.on('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        console.log('[qq] WS closed');
        resolve();
      });

      ws.on('error', (err: Error) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        console.error(`[qq] WS error: ${err.message}`);
        reject(err);
      });
    });
  }

  private handleEvent(eventType: string, data: any): void {
    // Handle C2C (direct) and group messages
    if (eventType === 'C2C_MESSAGE_CREATE' || eventType === 'AT_MESSAGE_CREATE') {
      const userId = data.author?.id || '';
      const chatId = data.channel_id || data.group_openid || '';
      const messageId = data.id || '';
      const text = (data.content || '').replace(/<@!\d+>/g, '').trim();

      if (!text) return;

      // Authorization
      if (this.allowedUsers && this.allowedUsers.length > 0) {
        if (!this.allowedUsers.includes(userId)) return;
      }

      const inbound: InboundMessage = {
        adapter: 'qq',
        chatId,
        messageId,
        userId,
        text,
        chatType: eventType === 'C2C_MESSAGE_CREATE' ? 'p2p' : 'group',
      };

      this.emit('message', inbound);
    }
  }

  // ── Token Management ──

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });

    const data = await resp.json() as any;
    if (!data.access_token) throw new Error(`QQ token error: ${JSON.stringify(data)}`);

    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in || 7200) - 120) * 1000,
    };
    return this.tokenCache.token;
  }

  // ── Reply Methods ──

  async createReply(messageId: string, initialText: string): Promise<ReplyHandle> {
    // QQ doesn't have card-style replies, so we send a text message
    const token = await this.getAccessToken();

    // For now, send a simple reply
    // (QQ API varies by message type — this handles the basic case)
    const resp = await fetch(`${QQ_API_BASE}/v2/groups/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        content: initialText,
        msg_type: 0,
        msg_id: messageId,
      }),
    });

    const data = await resp.json() as any;
    return { replyId: data.id || messageId };
  }

  async updateReply(_handle: ReplyHandle, _text: string): Promise<void> {
    // QQ doesn't support message editing in most contexts
    // The final text will be sent as a new message by the router
  }

  async sendText(chatId: string, text: string, replyTo?: string): Promise<string> {
    const token = await this.getAccessToken();

    const resp = await fetch(`${QQ_API_BASE}/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        content: text,
        msg_id: replyTo || undefined,
      }),
    });

    const data = await resp.json() as any;
    return data.id || '';
  }
}
