import { describe, expect, it } from "vitest";
import { compressIfNeeded } from "../../src/compress.js";
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

  async complete(messages: Message[]): Promise<string> {
    this.completeCalls.push(messages);
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

describe("compressIfNeeded", () => {
  it("uses configured tool result length in compression prompt", async () => {
    const client = new CaptureCompleteClient();
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
      { role: "user", content: "继续" },
    ];

    await compressIfNeeded(messages, config({ contextCompressionToolResultMaxChars: 120 }), client, 4);

    const prompt = String(client.completeCalls[0][0].content);
    expect(prompt).toContain("不超过 5000 字");
    expect(prompt).toContain("[工具结果]");
    expect(prompt).not.toContain("TAIL_SHOULD_NOT_APPEAR");
  });
});
