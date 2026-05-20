import type { Tool } from "../types.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function duckduckgoSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo 请求失败 (${response.status})`);
  }

  const html = await response.text();
  return parseDuckDuckGoHtml(html, count);
}

function parseDuckDuckGoHtml(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const resultLinks = [...html.matchAll(resultRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < Math.min(resultLinks.length, count); i++) {
    const rawUrl = resultLinks[i][1];
    const title = stripTags(resultLinks[i][2]);
    const snippet = snippets[i] ? stripTags(snippets[i][1]) : "";

    // DuckDuckGo 使用重定向 URL，提取实际地址
    const actualUrl = extractUrl(rawUrl) || rawUrl;

    results.push({ title, url: actualUrl, snippet });
  }

  return results;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function extractUrl(redirectUrl: string): string {
  try {
    const u = new URL(redirectUrl);
    return u.searchParams.get("uddg") || redirectUrl;
  } catch {
    return redirectUrl;
  }
}

export function createWebSearchTool(): Tool {
  return {
    name: "web_search",
    description: "搜索互联网获取最新信息。当用户的问题需要实时数据、新闻、或你不确定的事实信息时使用。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
        count: {
          type: "number",
          description: "返回结果数量，默认5",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = args.query as string;
      const count = (args.count as number) ?? 5;

      try {
        const results = await duckduckgoSearch(query, count);
        if (results.length === 0) {
          return JSON.stringify({ error: "未找到相关结果" });
        }
        return JSON.stringify({ results });
      } catch (err) {
        return JSON.stringify({
          error: `搜索失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
