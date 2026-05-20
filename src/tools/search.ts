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

// === SearXNG ===

class SearXNGProvider implements SearchProvider {
  name = "searxng";
  constructor(private url: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const resp = await fetch(
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
    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { headers: { "X-Subscription-Token": this.apiKey } },
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
    const resp = await fetch(
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
        return JSON.stringify({
          error: `搜索失败 (${provider.name}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
