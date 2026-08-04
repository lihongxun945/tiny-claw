import { describe, expect, it } from "vitest";
import { createModelClient } from "../../src/model/index.js";
import { LocalLlamaClient } from "../../src/model/local.js";
import { OpenAIChatClient } from "../../src/model/openai.js";
import { getLocalContextSize, getLocalModelDefinition, LOCAL_MODELS } from "../../src/model/local-catalog.js";
import { getEffectiveMaxContextTokens } from "../../src/plugins/core/compress.js";
import type { Config } from "../../src/types.js";

const baseConfig = {
  apiUrl: "https://example.com",
  apiKey: "key",
  model: "remote-model",
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
  workspacePath: "/tmp/tiny-claw-local-test",
  systemPrompt: "",
} satisfies Config;

describe("local model selection", () => {
  it("exposes the supported Qwen and Gemma models", () => {
    expect(LOCAL_MODELS.map((model) => model.id)).toEqual([
      "qwen3.5-0.8b-q4",
      "qwen3.5-2b-q4",
      "qwen3.5-4b-q4",
      "qwen3.5-9b-q4",
      "qwen3.5-27b-q4",
      "qwen3.5-35b-a3b-q4",
      "gemma-4-e2b-it-q4",
      "gemma-4-e4b-it-q4",
      "gemma-4-12b-it-q4",
      "gemma-4-26b-a4b-it-q4",
      "gemma-4-31b-it-q4",
    ]);
    expect(LOCAL_MODELS.filter((model) => model.family === "Qwen")).toHaveLength(6);
    expect(LOCAL_MODELS.filter((model) => model.family === "Gemma")).toHaveLength(5);
    expect(getLocalModelDefinition("qwen3.5-4b-q4").modelUri).toBe("hf:unsloth/Qwen3.5-4B-GGUF:Q4_0");
    expect(getLocalModelDefinition("qwen3.5-4b-q4").maxContextTokens).toBe(131072);
    expect(getLocalModelDefinition("gemma-4-12b-it-q4")).toMatchObject({
      modelUri: "hf:ggml-org/gemma-4-12B-it-GGUF:Q4_0",
      maxContextTokens: 262144,
    });
    expect(LOCAL_MODELS.every((model) => model.recommendedMemoryGb > 0)).toBe(true);
    expect(() => getLocalModelDefinition("unknown")).toThrow("不支持的本地模型");
  });

  it("uses the recommended local context and clamps values above the model limit", () => {
    expect(getLocalContextSize("qwen3.5-4b-q4", undefined)).toBe(32768);
    expect(getLocalContextSize("qwen3.5-4b-q4", 65536)).toBe(65536);
    expect(getLocalContextSize("qwen3.5-4b-q4", 200000)).toBe(131072);
    expect(getLocalContextSize("gemma-4-e2b-it-q4", 200000)).toBe(131072);
    expect(getLocalContextSize("gemma-4-12b-it-q4", 300000)).toBe(262144);
  });

  it("uses the actual local context as the compression budget in local-only mode", () => {
    expect(getEffectiveMaxContextTokens({
      ...baseConfig,
      maxContextTokens: 128000,
      remoteModel: { enabled: false },
      localModel: { enabled: true, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    })).toBe(32768);

    expect(getEffectiveMaxContextTokens({
      ...baseConfig,
      maxContextTokens: 128000,
      remoteModel: { enabled: true },
      localModel: { enabled: true, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    })).toBe(128000);
  });

  it("prefers the remote model when both are enabled", () => {
    const client = createModelClient({
      ...baseConfig,
      remoteModel: { enabled: true },
      localModel: { enabled: true, modelId: "qwen3.5-0.8b-q4" },
    });
    expect(client).toBeInstanceOf(OpenAIChatClient);
  });

  it("selects the local model when remote is disabled", () => {
    const client = createModelClient({
      ...baseConfig,
      remoteModel: { enabled: false },
      localModel: { enabled: true, modelId: "qwen3.5-0.8b-q4" },
    });
    expect(client).toBeInstanceOf(LocalLlamaClient);
  });
});
