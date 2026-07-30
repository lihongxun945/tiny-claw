import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIChatClient } from "../../src/model/openai.js";
import type { Config, Message } from "../../src/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { attachmentToImageBlock, saveAttachment } from "../../src/attachments.js";

function config(): Config {
  return {
    apiUrl: "https://example.test/v1",
    apiKey: "key",
    model: "test-model",
    modelProvider: "openai-chat",
    maxTokens: 1024,
    maxContextTokens: 128000,
    contextCompressionThreshold: 0.7,
    contextCompressionMaxChars: 5000,
    contextCompressionToolResultMaxChars: 500,
    toolResultInitialMaxChars: 12000,
    historyWindowSize: 5,
    maxAgentIterations: 20,
    searchProvider: "ollama",
    workspacePath: "/tmp/tiny-claw-test",
    systemPrompt: "",
  };
}

function successResponse(content = "ok"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function maxTokensError(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      param: "max_tokens",
      code: "unsupported_parameter",
    },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(text = "ok"): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("OpenAIChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send orphaned tool messages to OpenAI-compatible APIs", async () => {
    let requestBody: { messages: Array<{ role: string; tool_call_id?: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return successResponse();
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

  it("converts image attachments to OpenAI image_url content", async () => {
    const workspacePath = createTempWorkspace();
    let requestBody: { messages: Array<{ role: string; content: unknown }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return successResponse();
    }));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const record = saveAttachment(workspacePath, "image-session", "screen.png", "image/png", png);
    const client = new OpenAIChatClient({ ...config(), workspacePath });

    try {
      await client.complete([{
        role: "user",
        content: [
          { type: "text", text: "解释图片" },
          attachmentToImageBlock(record),
        ],
      }]);
      expect(requestBody?.messages[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "解释图片" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
          },
        ],
      });
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("repairs max_tokens errors for non-streaming requests and caches the parameter", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      return requestBodies.length === 1 ? maxTokensError() : successResponse();
    }));
    const client = new OpenAIChatClient(config());

    await client.complete([{ role: "user", content: "first" }]);
    await client.complete([{ role: "user", content: "second" }]);

    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[0]).toMatchObject({ max_tokens: 1024 });
    expect(requestBodies[1]).toMatchObject({ max_completion_tokens: 1024 });
    expect(requestBodies[1]).not.toHaveProperty("max_tokens");
    expect(requestBodies[2]).toMatchObject({ max_completion_tokens: 1024 });
  });

  it("repairs max_tokens errors for streaming chat requests", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requestBodies.length === 1 ? maxTokensError() : streamResponse("repaired");
    }));
    const client = new OpenAIChatClient(config());
    let streamed = "";

    const response = await client.chat(
      [{ role: "user", content: "hello" }],
      (text) => { streamed += text; },
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({ max_completion_tokens: 1024 });
    expect(response.text).toBe("repaired");
    expect(streamed).toBe("repaired");
  });

  it("does not retry unrelated API errors", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIChatClient(config());

    await expect(client.complete([{ role: "user", content: "hello" }]))
      .rejects.toThrow("API 请求失败 (400): invalid request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply the same repair more than once", async () => {
    const fetchMock = vi.fn(async () => maxTokensError());
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIChatClient(config());

    await expect(client.complete([{ role: "user", content: "hello" }]))
      .rejects.toThrow("API 请求失败 (400)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
