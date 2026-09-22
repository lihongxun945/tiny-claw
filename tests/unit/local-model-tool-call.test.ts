import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDebugEvent } from "../../src/model/types.js";
import type { Config, ToolDefinition } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  handlerResultUsed: false,
  promptError: null as Error | null,
  disposeSession: vi.fn(),
  disposeContext: vi.fn(),
  disposeModel: vi.fn(),
  loadModel: vi.fn(),
}));

vi.mock("../../src/model/local-store.js", () => ({
  getLocalModelPath: () => "/tmp/test-model.gguf",
}));

vi.mock("node-llama-cpp", () => {
  class LlamaChatSession {
    async promptWithMeta(_prompt: string, options: {
      functions?: Record<string, { handler: (input: unknown) => unknown }>;
      onTextChunk?: (text: string) => void;
    }) {
      if (mocks.promptError) throw mocks.promptError;
      options.onTextChunk?.("我来检查。\n");
      if (options.functions?.bash) {
        const result = await options.functions.bash.handler({ command: "lsof -i" });
        mocks.handlerResultUsed = true;
        options.onTextChunk?.(`查询结果：${String(result)}`);
        return { responseText: "不应生成的最终结果" };
      }
      return { responseText: "本地模型回复" };
    }

    dispose() {
      mocks.disposeSession();
    }
  }

  return {
    getLlama: async () => ({
      loadModel: mocks.loadModel.mockImplementation(async () => ({
        dispose: mocks.disposeModel,
        createContext: async () => ({
          getSequence: () => ({}),
          dispose: mocks.disposeContext,
        }),
      })),
    }),
    LlamaChatSession,
    defineChatSessionFunction: (definition: unknown) => definition,
  };
});

const config = {
  apiUrl: "https://example.com",
  apiKey: "",
  model: "",
  modelProvider: "openai-chat",
  maxTokens: 64,
  maxContextTokens: 4096,
  contextCompressionThreshold: 0.7,
  contextCompressionMaxChars: 1000,
  contextCompressionToolResultMaxChars: 500,
  toolResultInitialMaxChars: 12000,
  historyWindowSize: 5,
  maxAgentIterations: 20,
  searchProvider: "duckduckgo",
  workspacePath: "/tmp/tiny-claw-local-tool-test",
  systemPrompt: "",
  remoteModel: { enabled: false },
  localModel: { enabled: true, modelId: "qwen3.5-0.8b-q4" },
} satisfies Config;

const bashTool: ToolDefinition = {
  name: "bash",
  description: "执行 shell 命令",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

describe("LocalLlamaClient tool calls", () => {
  beforeEach(() => {
    mocks.handlerResultUsed = false;
    mocks.promptError = null;
    mocks.disposeSession.mockClear();
    mocks.disposeContext.mockClear();
    mocks.disposeModel.mockReset();
    mocks.loadModel.mockClear();
  });

  afterEach(async () => {
    const { disposeLocalModels } = await import("../../src/model/local.js");
    await disposeLocalModels();
  });

  it.each([false, true])("awaits context disposal before settling a request (failure=%s)", async (fail) => {
    const { LocalLlamaClient } = await import("../../src/model/local.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.disposeContext.mockReturnValueOnce(gate);
    if (fail) mocks.promptError = new Error("inference failed");
    let settled = false;
    const request = new LocalLlamaClient(config).complete([{ role: "user", content: "hello" }])
      .then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(mocks.disposeContext).toHaveBeenCalledOnce());
      expect(mocks.disposeSession).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
    } finally {
      release();
      await request;
    }
    expect(settled).toBe(true);
  });

  it("awaits model disposal, clears the cache and reloads on the next request", async () => {
    const { LocalLlamaClient, disposeLocalModels } = await import("../../src/model/local.js");
    const client = new LocalLlamaClient(config);
    await client.complete([{ role: "user", content: "hello" }]);
    await client.complete([{ role: "user", content: "again" }]);
    expect(mocks.loadModel).toHaveBeenCalledOnce();
    let release!: () => void;
    mocks.disposeModel.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    let disposed = false;
    const cleanup = disposeLocalModels().then(() => { disposed = true; });
    try {
      await vi.waitFor(() => expect(mocks.disposeModel).toHaveBeenCalledOnce());
      expect(disposed).toBe(false);
    } finally {
      release();
      await cleanup;
    }
    await disposeLocalModels();
    expect(mocks.disposeModel).toHaveBeenCalledOnce();
    await client.complete([{ role: "user", content: "reload" }]);
    expect(mocks.loadModel).toHaveBeenCalledTimes(2);
  });

  it("reports model disposal errors and allows cleanup to be retried", async () => {
    const { LocalLlamaClient, disposeLocalModels } = await import("../../src/model/local.js");
    await new LocalLlamaClient(config).complete([{ role: "user", content: "hello" }]);
    mocks.disposeModel.mockRejectedValueOnce(new Error("dispose failed"));
    await expect(disposeLocalModels()).rejects.toThrow("dispose failed");
    await disposeLocalModels();
    expect(mocks.disposeModel).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed model loads", async () => {
    const { LocalLlamaClient } = await import("../../src/model/local.js");
    mocks.loadModel.mockRejectedValueOnce(new Error("load failed"));
    const client = new LocalLlamaClient(config);
    await expect(client.complete([{ role: "user", content: "hello" }])).rejects.toThrow("load failed");
    await expect(client.complete([{ role: "user", content: "retry" }])).resolves.toBe("本地模型回复");
    expect(mocks.loadModel).toHaveBeenCalledTimes(2);
  });

  it("stops generation at the tool call instead of treating a placeholder as its result", async () => {
    const { createModelClient } = await import("../../src/model/index.js");
    const deltas: string[] = [];
    const debugEvents: ModelDebugEvent[] = [];
    const response = await createModelClient({
      ...config,
      debug: { enabled: true, modelIO: true },
    }, {
      sessionId: "local-session",
      reportDebug: (event) => debugEvents.push(event),
    }).chat(
      [{ role: "user", content: "检查 Node.js 服务" }],
      (text) => deltas.push(text),
      [bashTool],
    );

    expect(response.text).toBe("我来检查。\n");
    expect(response.toolCalls).toEqual([
      expect.objectContaining({ name: "bash", input: { command: "lsof -i" } }),
    ]);
    expect(deltas).toEqual(["我来检查。\n"]);
    expect(mocks.handlerResultUsed).toBe(false);
    expect(mocks.disposeSession).toHaveBeenCalledOnce();
    expect(mocks.disposeContext).toHaveBeenCalledOnce();
    expect(debugEvents.map((event) => event.phase)).toEqual(["request", "parsed_response"]);
    expect(debugEvents[0]).toMatchObject({
      sessionId: "local-session",
      provider: "local-llama",
      model: "qwen3.5-0.8b-q4",
      mode: "chat",
      data: {
        model: "qwen3.5-0.8b-q4",
        contextSize: 32768,
        maxTokens: 64,
      },
    });
    expect(debugEvents[1]?.data).toMatchObject({
      text: "我来检查。\n",
      toolCalls: [expect.objectContaining({ name: "bash" })],
    });
  });

  it("records local model errors without replacing the original failure", async () => {
    const { LocalLlamaClient } = await import("../../src/model/local.js");
    const debugEvents: ModelDebugEvent[] = [];
    mocks.promptError = new Error("本地推理失败");
    const client = new LocalLlamaClient({
      ...config,
      debug: true,
    }, {
      sessionId: "error-session",
      reportDebug: (event) => debugEvents.push(event),
    });

    await expect(client.complete([{ role: "user", content: "触发错误" }])).rejects.toThrow("本地推理失败");
    expect(debugEvents.map((event) => event.phase)).toEqual(["request", "error"]);
    expect(debugEvents[1]).toMatchObject({
      sessionId: "error-session",
      provider: "local-llama",
      mode: "complete",
      data: { message: "本地推理失败" },
    });
  });
});
