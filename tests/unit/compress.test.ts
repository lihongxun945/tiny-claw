import { describe, expect, it } from "vitest";
import { compressMessages } from "../../src/plugins/core/compress.js";
import type { HookContext } from "../../src/plugins/types.js";
import type { ModelClient } from "../../src/model/index.js";
import type { ChatResponse, Config, Message, ToolDefinition } from "../../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://example.com/api",
    apiKey: "model-key",
    model: "test-model",
    maxTokens: 4096,
    maxContextTokens: 100,
    contextCompressionThreshold: 0.1,
    contextCompressionMaxChars: 5000,
    contextCompressionToolResultMaxChars: 120,
    toolResultInitialMaxChars: 12000,
    historyWindowSize: 5,
    maxAgentIterations: 0,
    searchProvider: "ollama",
    workspacePath: "/tmp/test-workspace",
    systemPrompt: "",
    ...overrides,
  };
}

class CaptureCompleteClient implements ModelClient {
  completeCalls: Message[][] = [];
  completeOptions: Array<{ maxTokens?: number } | undefined> = [];

  async complete(messages: Message[], _systemPrompt?: string, options?: { maxTokens?: number }): Promise<string> {
    this.completeCalls.push(messages);
    this.completeOptions.push(options);
    return "压缩摘要";
  }

  async chat(
    _messages: Message[],
    _onDelta: (text: string) => void,
    _tools?: ToolDefinition[],
    _systemPrompt?: string,
    _signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return { text: "", toolCalls: [] };
  }
}

describe("compressMessages (core-compress plugin)", () => {
  it("uses configured tool result length in compression prompt", async () => {
    const client = new CaptureCompleteClient();
    const ctx = {
      config: config({ contextCompressionToolResultMaxChars: 120 }),
      client,
    } as unknown as HookContext;
    const longToolResult = `${"工具结果".repeat(80)}TAIL_SHOULD_NOT_APPEAR`;
    const messages: Message[] = [
      { role: "user", content: "请搜索" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "开始搜索" },
          { type: "tool_use", id: "tool-1", name: "web_search", input: { query: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: longToolResult }],
      },
      { role: "assistant", content: [{ type: "text", text: "搜索完成" }] },
    ];

    const result = await compressMessages(messages, ctx);

    const prompt = String(client.completeCalls[0][0].content);
    expect(prompt).toContain("不超过 5000 字");
    expect(prompt).toContain("[工具结果]");
    expect(prompt).not.toContain("TAIL_SHOULD_NOT_APPEAR");
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("[当前会话摘要]");
    expect(result[0].content).toContain("压缩摘要");
    expect(client.completeOptions[0]).toEqual({ maxTokens: 2048 });
  });

  it("returns no synthetic summary when the compression model fails", async () => {
    const client = new CaptureCompleteClient();
    client.complete = async () => { throw new Error("model unavailable"); };
    const ctx = { config: config(), client } as unknown as HookContext;

    await expect(compressMessages([{ role: "user", content: "必须保留的历史" }], ctx)).resolves.toEqual([]);
  });

  it("enforces the configured summary character limit after generation", async () => {
    const client = new CaptureCompleteClient();
    client.complete = async () => "摘要内容".repeat(100);
    const ctx = { config: config({ contextCompressionMaxChars: 100 }), client } as unknown as HookContext;

    const result = await compressMessages([{ role: "user", content: "历史" }], ctx);
    const content = String(result[0].content).replace("[当前会话摘要]\n", "");
    expect(content.length).toBeLessThanOrEqual(100);
  });
});
