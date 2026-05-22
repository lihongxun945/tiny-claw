const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const TOKEN_EXPIRE_MARGIN = 5 * 60 * 1000;
const MESSAGE_CHAR_LIMIT = 4000;

interface TokenCache {
  token: string;
  expireAt: number;
}

export class FeishuClient {
  private appId: string;
  private appSecret: string;
  private tokenCache: TokenCache | null = null;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  async getTenantToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expireAt) {
      return this.tokenCache.token;
    }

    const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    if (!res.ok) {
      throw new Error(`获取 tenant_access_token 失败: ${res.status}`);
    }

    const data = await res.json() as { tenant_access_token?: string; expire?: number; msg?: string };
    if (!data.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败: ${data.msg}`);
    }

    this.tokenCache = {
      token: data.tenant_access_token,
      expireAt: Date.now() + (data.expire ?? 7200) * 1000 - TOKEN_EXPIRE_MARGIN,
    };

    return this.tokenCache.token;
  }

  async replyMessage(messageId: string, text: string): Promise<void> {
    const token = await this.getTenantToken();
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      const card = buildMarkdownCard(chunk);
      const res = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}/reply`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`飞书回复消息失败: ${res.status} ${body}`);
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantToken();
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      const card = buildMarkdownCard(chunk);
      const res = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`飞书发送消息失败: ${res.status} ${body}`);
      }
    }
  }

  async addReaction(messageId: string, emoji: string): Promise<void> {
    const token = await this.getTenantToken();
    const res = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}/reactions`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`飞书添加表情失败: ${res.status} ${body}`);
    }
  }

  async deleteReaction(messageId: string, emoji: string): Promise<void> {
    const token = await this.getTenantToken();
    // 先列出消息的表情，找到对应 reaction_id
    const listRes = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}/reactions`, {
      headers: { "authorization": `Bearer ${token}` },
    });
    if (!listRes.ok) return;

    const listData = await listRes.json() as { data?: { items?: Array<{ reaction_id: string; reaction_type: { emoji_type: string } }> } };
    const target = listData.data?.items?.find((item) => item.reaction_type.emoji_type === emoji);
    if (!target) return;

    const res = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}/reactions/${target.reaction_id}`, {
      method: "DELETE",
      headers: { "authorization": `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`飞书删除表情失败: ${res.status}`);
    }
  }
}

function buildMarkdownCard(markdown: string): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  const lines = markdown.split("\n");
  let textBuffer: string[] = [];

  function flushText(): void {
    if (textBuffer.length > 0) {
      elements.push({ tag: "markdown", content: textBuffer.join("\n") });
      textBuffer = [];
    }
  }

  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && (isSeparatorRow(lines[i + 1]) || isTableRow(lines[i + 1]))) {
      flushText();
      const headerCells = parseRow(lines[i]);
      i++;
      if (i < lines.length && isSeparatorRow(lines[i])) i++;
      elements.push(createRowElement(headerCells, true));
      while (i < lines.length && isTableRow(lines[i])) {
        elements.push(createRowElement(parseRow(lines[i]), false));
        i++;
      }
    } else {
      textBuffer.push(lines[i]);
      i++;
    }
  }
  flushText();

  return { elements };
}

function isTableRow(line: string): boolean {
  return /^\|.*\|$/.test(line.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:]+\|$/.test(line.trim());
}

function parseRow(line: string): string[] {
  return line.trim().split("|").slice(1, -1).map((c) => c.trim());
}

function createRowElement(cells: string[], isHeader: boolean): Record<string, unknown> {
  return {
    tag: "column_set",
    columns: cells.map((cell) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [
        {
          tag: "markdown",
          content: isHeader ? `**${cell}**` : cell || " ",
        },
      ],
    })),
  };
}

function splitMessage(text: string): string[] {
  if (text.length <= MESSAGE_CHAR_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MESSAGE_CHAR_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", MESSAGE_CHAR_LIMIT);
    if (splitIdx <= 0) splitIdx = MESSAGE_CHAR_LIMIT;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
