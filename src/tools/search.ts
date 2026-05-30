import type { Tool, Config } from "../types.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchProvider {
  name: string;
  search(query: string, count: number): Promise<SearchResult[]>;
}

const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SEARCH_TIMEOUT = 3_000;

/** 带超时和 User-Agent 的 fetch 封装 */
async function searchFetch(url: string, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      headers: { "user-agent": SEARCH_UA, ...headers },
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// === SearXNG ===

class SearXNGProvider implements SearchProvider {
  name = "searxng";
  constructor(private url: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const resp = await searchFetch(
      `${this.url}/search?q=${encodeURIComponent(query)}&format=json`,
    );
    if (!resp.ok) {
      throw new Error(`SearXNG 请求失败 (${resp.status})`);
    }
    const data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (data.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  }
}

// === Brave Search ===

class BraveProvider implements SearchProvider {
  name = "brave";
  constructor(private apiKey: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const resp = await searchFetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { "X-Subscription-Token": this.apiKey },
    );
    if (!resp.ok) {
      throw new Error(`Brave Search 请求失败 (${resp.status})`);
    }
    const data = (await resp.json()) as {
      web?: {
        results?: Array<{ title?: string; url?: string; description?: string }>;
      };
    };
    return (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}

// === DuckDuckGo Instant Answer ===

class DuckDuckGoProvider implements SearchProvider {
  name = "duckduckgo";

  async search(query: string, count: number): Promise<SearchResult[]> {
    const resp = await searchFetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
    );
    if (!resp.ok) {
      throw new Error(`DuckDuckGo 请求失败 (${resp.status})`);
    }
    const data = (await resp.json()) as {
      Heading?: string;
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{
        FirstURL?: string;
        Text?: string;
        Name?: string;
        Topics?: Array<{ FirstURL?: string; Text?: string }>;
      }>;
    };

    const results: SearchResult[] = [];

    // 主摘要
    if (data.AbstractText) {
      results.push({
        title: data.Heading ?? "",
        url: data.AbstractURL ?? "",
        snippet: data.AbstractText,
      });
    }

    // RelatedTopics（可能包含子分类）
    type TopicItem = { FirstURL?: string; Text?: string; Name?: string; Topics?: TopicItem[] };
    const flattenTopics = (topics: TopicItem[]): Array<{ FirstURL?: string; Text?: string }> => {
      const flat: Array<{ FirstURL?: string; Text?: string }> = [];
      for (const t of topics) {
        if (t.Topics) {
          flat.push(...t.Topics);
        } else if (t.FirstURL && t.Text) {
          flat.push({ FirstURL: t.FirstURL, Text: t.Text });
        }
      }
      return flat;
    };

    const topics = flattenTopics(data.RelatedTopics ?? []);
    for (const t of topics) {
      if (results.length >= count) break;
      if (!t.FirstURL || !t.Text) continue;
      // Text 格式通常是 "Title - Description"，尝试拆分
      const dashIdx = t.Text.indexOf(" - ");
      results.push({
        title: dashIdx > 0 ? t.Text.slice(0, dashIdx) : t.Text.slice(0, 80),
        url: t.FirstURL,
        snippet: dashIdx > 0 ? t.Text.slice(dashIdx + 3) : t.Text,
      });
    }

    return results;
  }
}

function createProvider(config: Config): SearchProvider {
  switch (config.searchProvider) {
    case "brave": {
      if (!config.braveApiKey) {
        throw new Error("使用 Brave Search 需要配置 braveApiKey");
      }
      return new BraveProvider(config.braveApiKey);
    }
    case "duckduckgo":
      return new DuckDuckGoProvider();
    case "searxng":
    default: {
      if (!config.searxngUrl) {
        throw new Error("使用 SearXNG 需要配置 searxngUrl（自建实例地址）");
      }
      return new SearXNGProvider(config.searxngUrl);
    }
  }
}

export function createWebSearchTool(config: Config): Tool {
  const description = config.searchProvider === "duckduckgo"
    ? "搜索互联网获取信息。当前使用 DuckDuckGo Instant Answer，query 适合输入1-3个简短英文实体关键词（如 'JavaScript'、'iPhone 17'），不要输入完整句子或长查询。搜索结果由你负责总结。"
    : "搜索互联网获取信息。query 可以使用清晰、具体的常规搜索查询；搜索结果由你负责总结。";

  return {
    name: "web_search",
    description,
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

      let provider: SearchProvider;
      try {
        provider = createProvider(config);
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const results = await provider.search(query, count);
        if (results.length === 0) {
          return JSON.stringify({ error: "未找到相关结果" });
        }
        return JSON.stringify({ results });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof Error && err.name === "AbortError";
        return JSON.stringify({
          error: isTimeout
            ? `搜索超时 (${provider.name}，${SEARCH_TIMEOUT / 1000}秒)`
            : `搜索失败 (${provider.name}): ${msg}`,
        });
      }
    },
  };
}
