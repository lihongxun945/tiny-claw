import type { Tool } from "../types.js";

const WEB_FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WEB_FETCH_TIMEOUT = 15_000;
const MAX_CONTENT_LENGTH = 50_000;

/** 简易 HTML → 纯文本转换 */
function htmlToText(html: string): string {
  let text = html;
  // 移除 script/style
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // 移除标签
  text = text.replace(/<[^>]+>/g, " ");
  // 解码常见 HTML 实体
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // 合并空白
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export function createWebFetchTool(): Tool {
  return {
    name: "web_fetch",
    description: "获取网页内容并转为纯文本。输入 URL，返回页面文本内容。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要获取的网页 URL",
        },
      },
      required: ["url"],
    },
    execute: async (args) => {
      const url = args.url as string;

      try {
        new URL(url);
      } catch {
        return JSON.stringify({ error: "无效的 URL" });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT);
      try {
        const resp = await fetch(url, {
          headers: { "user-agent": WEB_FETCH_UA },
          signal: controller.signal,
        });
        if (!resp.ok) {
          return JSON.stringify({ error: `请求失败 (${resp.status})` });
        }

        const contentType = resp.headers.get("content-type") ?? "";
        if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
          return JSON.stringify({ error: `不支持的内容类型: ${contentType}` });
        }

        const body = await resp.text();
        const text = htmlToText(body);
        const truncated = text.length > MAX_CONTENT_LENGTH;
        const content = truncated ? text.slice(0, MAX_CONTENT_LENGTH) : text;

        return JSON.stringify({
          url,
          content,
          truncated,
        });
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "AbortError";
        return JSON.stringify({
          error: isTimeout
            ? `请求超时（${WEB_FETCH_TIMEOUT / 1000}秒）`
            : `请求失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
