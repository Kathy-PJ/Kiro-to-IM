/**
 * Feishu Thread Context Aggregation
 *
 * Collects all user messages from a Feishu thread and builds
 * a context string for the ACP prompt, like acp-link's aggregate_thread.
 *
 * This allows the agent to see the full conversation context
 * within a Feishu thread, including text, image references, and files.
 */

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

interface TokenProvider {
  getToken(): Promise<string>;
}

interface ThreadMessage {
  role: 'user' | 'assistant';
  type: 'text' | 'image' | 'file';
  content: string;
  messageId: string;
}

/**
 * Create a simple token provider from app credentials.
 */
export function createTokenProvider(
  appId: string,
  appSecret: string,
  domain?: string,
): TokenProvider {
  let cache: { token: string; expiresAt: number } | null = null;
  const apiBase = (domain || FEISHU_API_BASE).replace(/\/+$/, '');
  const base = apiBase.includes('/open-apis') ? apiBase : apiBase + '/open-apis';

  return {
    async getToken(): Promise<string> {
      if (cache && Date.now() < cache.expiresAt) return cache.token;

      const resp = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const data = await resp.json() as any;
      if (data.code !== 0) throw new Error(`Token error: ${data.msg}`);

      cache = {
        token: data.tenant_access_token,
        expiresAt: Date.now() + ((data.expire || 7200) - 120) * 1000,
      };
      return cache.token;
    },
  };
}

/**
 * Get all messages in a Feishu thread (with pagination).
 */
export async function getThreadMessages(
  tokenProvider: TokenProvider,
  threadId: string,
  domain?: string,
): Promise<any[]> {
  const base = (domain || FEISHU_API_BASE).replace(/\/+$/, '');
  const apiBase = base.includes('/open-apis') ? base : base + '/open-apis';
  const token = await tokenProvider.getToken();

  const allMessages: any[] = [];
  let pageToken: string | null = null;

  while (true) {
    let url = `${apiBase}/im/v1/messages?container_id_type=thread&container_id=${threadId}&page_size=50`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    if (data.code !== 0) throw new Error(`Get thread messages failed: ${data.msg}`);

    const items = data.data?.items || [];
    allMessages.push(...items);

    pageToken = data.data?.page_token || null;
    if (!pageToken) break;
  }

  return allMessages;
}

/**
 * Aggregate thread messages into a context string.
 *
 * Filters out bot messages, extracts text content,
 * and builds a formatted context for the prompt.
 *
 * Returns { texts, imageKeys, fileKeys, contextString }.
 */
export async function aggregateThreadContext(
  tokenProvider: TokenProvider,
  threadId: string,
  chatId: string,
  currentMessageId: string,
  domain?: string,
): Promise<{
  texts: string[];
  contextString: string;
}> {
  const messages = await getThreadMessages(tokenProvider, threadId, domain);

  const texts: string[] = [];

  for (const msg of messages) {
    const senderType = msg.sender?.sender_type || '';
    // Skip bot/app messages
    if (senderType === 'app' || senderType === 'bot') continue;

    const msgType = msg.msg_type || '';
    const contentStr = msg.body?.content || '';

    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(contentStr);
        const text = (parsed.text || '').trim();
        if (text) texts.push(text);
      } catch {
        if (contentStr.trim()) texts.push(contentStr.trim());
      }
    }
    // Image and file messages are noted but not downloaded
    // (downloading would require resource storage like acp-link)
    else if (msgType === 'image') {
      texts.push('[image]');
    } else if (msgType === 'file') {
      try {
        const parsed = JSON.parse(contentStr);
        texts.push(`[file: ${parsed.file_name || 'unknown'}]`);
      } catch {
        texts.push('[file]');
      }
    }
  }

  const contextString = [
    `[feishu_context: message_id=${currentMessageId}, chat_id=${chatId}, thread_id=${threadId}]`,
    '',
    ...texts.map((t, i) => `[${i + 1}] ${t}`),
  ].join('\n');

  return { texts, contextString };
}
