import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../../src/tools/web_fetch.js";

describe("web_fetch tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts HTML to plain text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<style>x</style><p>Hello &amp; world</p>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    expect(JSON.parse(await createWebFetchTool().execute({ url: "https://example.com" }))).toMatchObject({
      url: "https://example.com",
      content: "Hello & world",
      truncated: false,
    });
  });

  it("cancels an active request when the parent signal aborts", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const controller = new AbortController();
    const running = createWebFetchTool().execute({ url: "https://example.com" }, { signal: controller.signal });
    controller.abort();
    expect(JSON.parse(await running)).toEqual({ error: "请求已取消" });
  });
});
