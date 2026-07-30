import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesClient } from "../../src/model/anthropic.js";
import { attachmentToImageBlock, saveAttachment } from "../../src/attachments.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import type { Config } from "../../src/types.js";

describe("AnthropicMessagesClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("converts image attachments to Anthropic base64 content", async () => {
    const workspacePath = createTempWorkspace();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const record = saveAttachment(workspacePath, "image-session", "screen.png", "image/png", png);
    let requestBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const config: Config = {
      apiUrl: "https://example.test",
      apiKey: "key",
      model: "test-model",
      maxTokens: 1024,
      maxContextTokens: 128000,
      contextCompressionThreshold: 0.7,
      contextCompressionMaxChars: 5000,
      contextCompressionToolResultMaxChars: 500,
      toolResultInitialMaxChars: 12000,
      historyWindowSize: 5,
      maxAgentIterations: 20,
      searchProvider: "ollama",
      workspacePath,
      systemPrompt: "",
    };

    try {
      await new AnthropicMessagesClient(config).complete([{
        role: "user",
        content: [
          { type: "text", text: "解释图片" },
          attachmentToImageBlock(record),
        ],
      }]);
      expect(requestBody?.messages[0].content).toEqual([
        { type: "text", text: "解释图片" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: png.toString("base64"),
          },
        },
      ]);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
