import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIChatClient } from "../../src/model/openai.js";
import type { Config, Message } from "../../src/types.js";

function config(): Config {
  return {
    apiUrl: "https://example.test/v1",
    apiKey: "key",
    model: "test-model",
    modelProvider: "openai-chat",
    maxTokens: 1024,
    maxContextTokens: 128000,
    contextCompressionThreshold: 0.7,
    historyWindowSize: 5,
    maxAgentIterations: 20,
    searchProvider: "ollama",
    workspacePath: "/tmp/tiny-claw-test",
    systemPrompt: "",
  };
}

describe("OpenAIChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send orphaned tool messages to OpenAI-compatible APIs", async () => {
    let requestBody: { messages: Array<{ role: string; tool_call_id?: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const client = new OpenAIChatClient(config());
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "orphan" }],
      },
      { role: "user", content: "hello" },
    ];

    await client.complete(messages);

    expect(requestBody?.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });
});
