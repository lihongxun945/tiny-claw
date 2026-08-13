import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultConfig, ensureConfigFile, loadConfig, validateConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("loadConfig", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspacePath of workspaces.splice(0)) {
      removeTempWorkspace(workspacePath);
    }
  });

  it("loads defaults and identity from the workspace", () => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    writeFileSync(resolve(workspacePath, "identity.md"), "You are tiny-claw.", "utf-8");

    expect(loadConfig(workspacePath)).toMatchObject({
      apiUrl: "https://example.com/api",
      apiKey: "test-api-key",
      model: "test-model",
      modelProvider: "anthropic-messages",
      remoteModel: { enabled: true },
      localModel: { enabled: false, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
      maxTokens: 16384,
      maxContextTokens: 128000,
      contextCompressionThreshold: 0.7,
      contextCompressionMaxChars: 5000,
      contextCompressionToolResultMaxChars: 500,
      contextCompressionMaxOutputTokens: 2048,
      toolResultInitialMaxChars: 12000,
      historyWindowSize: 5,
      maxAgentIterations: 100,
      searchProvider: "ollama",
      workspacePath,
      systemPrompt: "You are tiny-claw.",
    });
  });

  it.each(["config.simple.example.json", "config.all.example.json"])("keeps %s valid", (fileName) => {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), fileName), "utf-8"));
    expect(() => validateConfig(raw)).not.toThrow();
  });

  it("creates a complete first-run config without user credentials", () => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    const configPath = resolve(workspacePath, "config.json");
    rmSync(configPath);

    ensureConfigFile(workspacePath);

    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw).toMatchObject({
      apiUrl: "https://api.deepseek.com",
      apiKey: "",
      model: "deepseek-chat",
      searchProvider: "duckduckgo",
      enabledPlugins: [],
      plugins: {},
      security: { mode: "auto", gateway: { sseHeartbeatIntervalMs: 15000 } },
      remoteModel: { enabled: true },
      localModel: { enabled: false, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    });
    expect(() => validateConfig(raw)).not.toThrow();
  });

  it("allows an empty API key while keeping the field required", () => {
    expect(() => validateConfig(createDefaultConfig())).not.toThrow();
    expect(() => validateConfig({ ...createDefaultConfig(), apiKey: undefined })).toThrow("配置字段 apiKey 必须是字符串");
  });

  it("supports local-only mode and rejects disabling every model", () => {
    expect(() => validateConfig({
      ...createDefaultConfig(),
      remoteModel: { enabled: false },
      localModel: { enabled: true, modelId: "qwen3.5-0.8b-q4", contextSize: 2048 },
    })).not.toThrow();
    expect(() => validateConfig({
      ...createDefaultConfig(),
      localModel: { enabled: true, modelId: "gemma-4-e4b-it-q4", contextSize: 8192 },
    })).not.toThrow();
    expect(() => validateConfig({
      ...createDefaultConfig(),
      localModel: { enabled: true, modelId: "qwen3.5-35b-a3b-q4", contextSize: 32768 },
    })).not.toThrow();
    expect(() => validateConfig({
      ...createDefaultConfig(),
      localModel: { enabled: true, modelId: "gemma-4-31b-it-q4", contextSize: 262144 },
    })).not.toThrow();
    expect(() => validateConfig({
      ...createDefaultConfig(),
      remoteModel: { enabled: false },
      localModel: { enabled: false },
    })).toThrow("远程模型和本地模型至少需要启用一个");
  });

  it("loads provider-specific search configuration", () => {
    const workspacePath = createTempWorkspace({
      searchProvider: "ollama",
      ollamaApiKey: "ollama-key",
      braveApiKey: "brave-key",
      searxngUrl: "http://localhost:8080",
    });
    workspaces.push(workspacePath);

    expect(loadConfig(workspacePath)).toMatchObject({
      searchProvider: "ollama",
      ollamaApiKey: "ollama-key",
      braveApiKey: "brave-key",
      searxngUrl: "http://localhost:8080",
    });
  });

  it("drops deprecated auto-memory fields when loading config", () => {
    const workspacePath = createTempWorkspace({
      autoMemory: {
        enabled: true,
        mode: "hybrid",
        turnThreshold: 10,
        minConfidence: 0.75,
        maxCandidates: 5,
      },
    });
    workspaces.push(workspacePath);

    expect(loadConfig(workspacePath).autoMemory).toEqual({
      enabled: true,
      mode: "hybrid",
      turnThreshold: 10,
      maxCandidates: 5,
      maxBatchChars: undefined,
      lockTimeoutSeconds: undefined,
    });
  });

  it.each([
    [{ apiKey: "key", model: "model" }, "配置缺少 apiUrl"],
    [{ apiUrl: "url", model: "model" }, "配置缺少 apiKey"],
    [{ apiUrl: "url", apiKey: "key" }, "配置缺少 model"],
  ])("rejects missing required fields", (config, message) => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    writeFileSync(resolve(workspacePath, "config.json"), JSON.stringify(config), "utf-8");

    expect(() => loadConfig(workspacePath)).toThrow(message);
  });

  it.each([
    [{ maxTokens: 0 }, "配置字段 maxTokens 超出允许范围"],
    [{ contextCompressionMaxChars: 99 }, "配置字段 contextCompressionMaxChars 超出允许范围"],
    [{ contextCompressionToolResultMaxChars: 99 }, "配置字段 contextCompressionToolResultMaxChars 超出允许范围"],
    [{ contextCompressionMaxOutputTokens: 255 }, "配置字段 contextCompressionMaxOutputTokens 超出允许范围"],
    [{ toolResultInitialMaxChars: 999 }, "配置字段 toolResultInitialMaxChars 超出允许范围"],
    [{ maxAgentIterations: -1 }, "配置字段 maxAgentIterations 超出允许范围"],
    [{ emptyResponseRetries: 6 }, "配置字段 emptyResponseRetries 超出允许范围"],
    [{ searchProvider: "unknown" }, "配置字段 searchProvider 不受支持"],
    [{ security: { mode: "unknown" } }, "配置字段 security.mode 不受支持"],
    [{ security: { tools: [] } }, "配置字段 security.tools 必须是对象"],
    [{ security: { tools: { bash: { mode: "unknown" } } } }, "配置字段 security.tools.bash.mode 不受支持"],
    [{ security: { gateway: { host: "0.0.0.0" } } }, "Gateway 暴露到非回环地址时必须配置 security.gateway.token"],
    [{ security: { gateway: { sseHeartbeatIntervalMs: 999 } } }, "配置字段 security.gateway.sseHeartbeatIntervalMs 超出允许范围"],
    [{ project: { security: { mode: "unknown" } } }, "配置字段 project.security.mode 不受支持"],
    [{ project: { security: { tools: { bash: { mode: "unknown" } } } } }, "配置字段 project.security.tools.bash.mode 不受支持"],
    [{ project: { treeMaxDepth: 0 } }, "配置字段 project.treeMaxDepth 超出允许范围"],
    [{ project: { searchMaxResults: 0 } }, "配置字段 project.searchMaxResults 超出允许范围"],
    [{ plan: { maxSteps: 1 } }, "配置字段 plan.maxSteps 超出允许范围"],
    [{ subAgent: { maxConcurrency: 9 } }, "配置字段 subAgent.maxConcurrency 超出允许范围"],
    [{ autoMemory: { lockTimeoutSeconds: 0 } }, "配置字段 autoMemory.lockTimeoutSeconds 超出允许范围"],
    [{ memory: { maxItemChars: 999 } }, "配置字段 memory.maxItemChars 超出允许范围"],
    [{ memory: { maxItemChars: 2000, maxTotalChars: 1000 } }, "配置字段 memory.maxItemChars 不能大于 memory.maxTotalChars"],
    [{ sessionSummary: { enabled: "yes" } }, "配置字段 sessionSummary.enabled 必须是布尔值"],
    [{ sessionSummary: { persistent: "yes" } }, "配置字段 sessionSummary.persistent 必须是布尔值"],
    [{ enabledPlugins: "feishu" }, "配置字段 enabledPlugins 必须是字符串数组"],
    [{ plugins: [] }, "配置字段 plugins 必须是对象"],
  ])("rejects invalid configuration", (overrides, message) => {
    const workspacePath = createTempWorkspace(overrides);
    workspaces.push(workspacePath);
    expect(() => loadConfig(workspacePath)).toThrow(message);
  });

  it("loads custom context compression limits", () => {
    const workspacePath = createTempWorkspace({
      contextCompressionMaxChars: 1200,
      contextCompressionToolResultMaxChars: 300,
      contextCompressionMaxOutputTokens: 1024,
      toolResultInitialMaxChars: 6000,
    });
    workspaces.push(workspacePath);

    expect(loadConfig(workspacePath).contextCompressionMaxChars).toBe(1200);
    expect(loadConfig(workspacePath).contextCompressionToolResultMaxChars).toBe(300);
    expect(loadConfig(workspacePath).contextCompressionMaxOutputTokens).toBe(1024);
    expect(loadConfig(workspacePath).toolResultInitialMaxChars).toBe(6000);
  });
});
