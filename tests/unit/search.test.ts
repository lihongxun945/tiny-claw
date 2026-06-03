import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../../src/tools/search.js";
import type { Config } from "../../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://example.com/api",
    apiKey: "model-key",
    model: "test-model",
    maxTokens: 4096,
    maxContextTokens: 128000,
    contextCompressionThreshold: 0.7,
    historyWindowSize: 5,
    maxAgentIterations: 0,
    searchProvider: "ollama",
    workspacePath: "/tmp/test-workspace",
    systemPrompt: "",
    ...overrides,
  };
}

describe("web_search tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls Ollama Web Search with bearer auth and maps content to snippet", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "Ollama", url: "https://ollama.com", content: "Cloud models" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool(config({ ollamaApiKey: "ollama-key" }));
    const result = JSON.parse(await tool.execute({ query: "what is ollama", count: 3 }));

    expect(result.results).toEqual([
      { title: "Ollama", url: "https://ollama.com", snippet: "Cloud models" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/web_search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer ollama-key",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ query: "what is ollama", max_results: 3 }),
      }),
    );
  });

  it("reads the latest config on every execution", async () => {
    let ollamaApiKey: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "updated", url: "https://example.com", content: "ok" }],
    }), { status: 200 })));

    const tool = createWebSearchTool(() => config({ ollamaApiKey }));
    expect(JSON.parse(await tool.execute({ query: "test" }))).toEqual({
      error: "使用 Ollama Web Search 需要配置 ollamaApiKey",
    });

    ollamaApiKey = "new-key";
    expect(JSON.parse(await tool.execute({ query: "test" })).results[0].title).toBe("updated");
  });

  it("maps Brave Search results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      web: { results: [{ title: "Brave", url: "https://brave.com", description: "Search" }] },
    }), { status: 200 })));

    const result = JSON.parse(await createWebSearchTool(config({
      searchProvider: "brave",
      braveApiKey: "brave-key",
    })).execute({ query: "brave" }));

    expect(result.results[0]).toEqual({
      title: "Brave",
      url: "https://brave.com",
      snippet: "Search",
    });
  });

  it("maps SearXNG Search results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "SearXNG", url: "https://searxng.org", content: "Meta search" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(await createWebSearchTool(config({
      searchProvider: "searxng",
      searxngUrl: "http://localhost:8080",
    })).execute({ query: "meta search" }));

    expect(result.results[0]).toEqual({
      title: "SearXNG",
      url: "https://searxng.org",
      snippet: "Meta search",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8080/search?q=meta%20search&format=json");
  });

  it("maps DuckDuckGo abstracts and related topics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      Heading: "TypeScript",
      AbstractText: "TypeScript is a language.",
      AbstractURL: "https://example.com/typescript",
      RelatedTopics: [
        { FirstURL: "https://example.com/handbook", Text: "Handbook - TypeScript handbook" },
      ],
    }), { status: 200 })));

    const tool = createWebSearchTool(config({ searchProvider: "duckduckgo" }));
    const result = JSON.parse(await tool.execute({ query: "TypeScript", count: 2 }));

    expect(tool.description).toContain("1-3个简短英文实体关键词");
    expect(result.results).toEqual([
      {
        title: "TypeScript",
        url: "https://example.com/typescript",
        snippet: "TypeScript is a language.",
      },
      {
        title: "Handbook",
        url: "https://example.com/handbook",
        snippet: "TypeScript handbook",
      },
    ]);
  });

  it("returns a useful error when a provider is missing configuration", async () => {
    expect(JSON.parse(await createWebSearchTool(config()).execute({ query: "test" }))).toEqual({
      error: "使用 Ollama Web Search 需要配置 ollamaApiKey",
    });
    expect(JSON.parse(await createWebSearchTool(config({ searchProvider: "brave" })).execute({ query: "test" }))).toEqual({
      error: "使用 Brave Search 需要配置 braveApiKey",
    });
    expect(JSON.parse(await createWebSearchTool(config({ searchProvider: "searxng" })).execute({ query: "test" }))).toEqual({
      error: "使用 SearXNG 需要配置 searxngUrl（自建实例地址）",
    });
  });

  it("normalizes provider errors and empty results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    expect(JSON.parse(await createWebSearchTool(config({ ollamaApiKey: "key" })).execute({ query: "empty" }))).toEqual({
      error: "未找到相关结果",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    expect(JSON.parse(await createWebSearchTool(config({ ollamaApiKey: "key" })).execute({ query: "unauthorized" }))).toEqual({
      error: "搜索失败 (ollama): Ollama Web Search 请求失败 (401)",
    });
  });

  it("cancels an active search when the parent signal aborts", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const controller = new AbortController();
    const running = createWebSearchTool(config({ ollamaApiKey: "key" }))
      .execute({ query: "cancel" }, { signal: controller.signal });
    controller.abort();
    expect(JSON.parse(await running)).toEqual({ error: "搜索已取消 (ollama)" });
  });
});
