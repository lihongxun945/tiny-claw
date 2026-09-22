import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultConfig, ensureConfigFile, loadConfig, normalizeConfigForApi, resolveModelProfile, restoreMaskedSecrets, stripDeprecatedConfigFields, validateConfig } from "../../src/config.js";
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
      localModel: { enabled: false },
      maxTokens: 16384,
      maxContextTokens: 128000,
      contextCompressionThreshold: 0.8,
      contextCompressionTargetRatio: 0.2,
      maxAgentIterations: 1000,
      searchProvider: "duckduckgo",
      workspacePath,
      systemPrompt: "You are tiny-claw.",
    });
  });

  it("uses the new iteration defaults and preserves explicit limits", () => {
    const defaults = createDefaultConfig();
    expect(defaults).toMatchObject({
      maxAgentIterations: 1000,
      project: { maxAgentIterations: 1000 },
      subAgent: { maxIterations: 100 },
    });
    expect(() => validateConfig(defaults)).not.toThrow();
    const workspace = createTempWorkspace({ maxAgentIterations: 50, subAgent: { maxIterations: 12 } });
    workspaces.push(workspace);
    expect(loadConfig(workspace)).toMatchObject({ maxAgentIterations: 50, subAgent: { maxIterations: 12 } });
  });

  it("ignores obsolete values without changing active custom settings or the original file", () => {
    const legacy = {
      contextCompressionMaxChars: -1, historyWindowSize: "old",
      sessionSummary: { turnThreshold: 0, maxChars: 0, recentTurns: 7 },
      plan: { maxGateCorrections: -1, decisionRetries: -1, maxSteps: 12 },
      project: { historyWindowSize: -1, maxAgentIterations: 20 },
      profile: { enabled: false, maxItemChars: 4000, maxTotalChars: 9000 },
      searchProvider: "brave",
    };
    const workspace = createTempWorkspace(legacy);
    workspaces.push(workspace);
    const loaded = loadConfig(workspace);
    expect(loaded.sessionSummary).not.toHaveProperty("recentTurns");
    expect(loaded).toMatchObject({ plan: { maxSteps: 12 }, profile: legacy.profile, searchProvider: "brave" });
    expect(stripDeprecatedConfigFields(legacy)).toEqual({
      sessionSummary: {}, plan: { maxSteps: 12 }, project: { maxAgentIterations: 20 }, profile: legacy.profile, searchProvider: "brave",
    });
    expect(readFileSync(resolve(workspace, "config.json"), "utf8")).toContain("historyWindowSize");
    expect(JSON.stringify(createDefaultConfig())).not.toContain("maxGateCorrections");
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
      models: [
        { id: "deepseek", name: "DeepSeek", provider: "openai-chat", model: "deepseek-chat", apiUrl: "https://api.deepseek.com", apiKey: "" },
      ],
      defaultModelId: "deepseek",
      searchProvider: "duckduckgo",
      enabledPlugins: [],
      plugins: {},
      security: { mode: "auto", gateway: { sseHeartbeatIntervalMs: 15000 } },
    });
    expect(() => validateConfig(raw)).not.toThrow();
  });

  it("allows an empty API key in model profiles", () => {
    expect(() => validateConfig(createDefaultConfig())).not.toThrow();
    expect(() => validateConfig({
      models: [{ id: "m", provider: "openai-chat", model: "gpt-4o", apiUrl: "https://api.openai.com/v1", apiKey: "" }],
    })).not.toThrow();
  });

  it("supports local-only mode and rejects an empty model list", () => {
    const localOnly = (localModelId: string, contextSize: number) => ({
      models: [{ id: "local", name: "本地模型", provider: "local-llama", localModelId, contextSize }],
      defaultModelId: "local",
    });
    expect(() => validateConfig(localOnly("qwen3.5-0.8b-q4", 2048))).not.toThrow();
    expect(() => validateConfig(localOnly("gemma-4-e4b-it-q4", 8192))).not.toThrow();
    expect(() => validateConfig(localOnly("qwen3.5-35b-a3b-q4", 32768))).not.toThrow();
    expect(() => validateConfig(localOnly("gemma-4-31b-it-q4", 262144))).not.toThrow();
    expect(() => validateConfig({ models: [] })).toThrow("至少需要配置一个模型");
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
    [{ maxAgentIterations: -1 }, "配置字段 maxAgentIterations 超出允许范围"],
    [{ subAgent: { maxIterations: 101 } }, "配置字段 subAgent.maxIterations 超出允许范围"],
    [{ emptyResponseRetries: 6 }, "配置字段 emptyResponseRetries 超出允许范围"],
    [{ searchProvider: "unknown" }, "配置字段 searchProvider 不受支持"],
    [{ security: { mode: "unknown" } }, "配置字段 security.mode 不受支持"],
    [{ security: { mode: "deny" } }, "配置字段 security.mode 不受支持"],
    [{ security: { tools: [] } }, "配置字段 security.tools 必须是对象"],
    [{ security: { tools: { bash: { mode: "unknown" } } } }, "配置字段 security.tools.bash.mode 不受支持"],
    [{ security: { tools: { bash: { mode: "deny" } } } }, "配置字段 security.tools.bash.mode 不受支持"],
    [{ security: { gateway: { host: "0.0.0.0" } } }, "Gateway 暴露到非回环地址时必须配置 security.gateway.token"],
    [{ security: { gateway: { sseHeartbeatIntervalMs: 999 } } }, "配置字段 security.gateway.sseHeartbeatIntervalMs 超出允许范围"],
    [{ project: { security: { mode: "unknown" } } }, "配置字段 project.security.mode 不受支持"],
    [{ project: { security: { tools: { bash: { mode: "unknown" } } } } }, "配置字段 project.security.tools.bash.mode 不受支持"],
    [{ project: { treeMaxDepth: 0 } }, "配置字段 project.treeMaxDepth 超出允许范围"],
    [{ project: { searchMaxResults: 0 } }, "配置字段 project.searchMaxResults 超出允许范围"],
    [{ plan: { maxSteps: 0 } }, "配置字段 plan.maxSteps 超出允许范围"],
    [{ subAgent: { maxConcurrency: 9 } }, "配置字段 subAgent.maxConcurrency 超出允许范围"],
    [{ autoMemory: { lockTimeoutSeconds: 0 } }, "配置字段 autoMemory.lockTimeoutSeconds 超出允许范围"],
    [{ memory: { maxItemChars: 999 } }, "配置字段 memory.maxItemChars 超出允许范围"],
    [{ memory: { maxItemChars: 2000, maxTotalChars: 1000 } }, "配置字段 memory.maxItemChars 不能大于 memory.maxTotalChars"],
    [{ sessionSummary: { enabled: "yes" } }, "配置字段 sessionSummary.enabled 必须是布尔值"],
    [{ sessionSummary: { persistent: "yes" } }, "配置字段 sessionSummary.persistent 必须是布尔值"],
    [{ sessionSummary: { maxOperations: 0 } }, "配置字段 sessionSummary.maxOperations 超出允许范围"],
    [{ sessionSummary: { maxItemChars: 0 } }, "配置字段 sessionSummary.maxItemChars 超出允许范围"],
    [{ sessionSummary: { maxSourcesPerOperation: 0 } }, "配置字段 sessionSummary.maxSourcesPerOperation 超出允许范围"],
    [{ sessionSummary: { checkpointDeltaThreshold: 0 } }, "配置字段 sessionSummary.checkpointDeltaThreshold 超出允许范围"],
    [{ sessionSummary: { checkpointMaxChars: 999 } }, "配置字段 sessionSummary.checkpointMaxChars 超出允许范围"],
    [{ enabledPlugins: "feishu" }, "配置字段 enabledPlugins 必须是字符串数组"],
    [{ plugins: [] }, "配置字段 plugins 必须是对象"],
    [{ pluginStates: [] }, "配置字段 pluginStates 必须是对象"],
    [{ pluginStates: { demo: { enabled: "yes" } } }, "配置字段 pluginStates.demo.enabled 必须是布尔值"],
    [{ notifications: { enabled: "yes" } }, "配置字段 notifications.enabled 必须是布尔值"],
    [{ notifications: { reasons: ["unknown"] } }, "配置字段 notifications.reasons 包含不支持的触发类型"],
  ])("rejects invalid configuration", (overrides, message) => {
    const workspacePath = createTempWorkspace(overrides);
    workspaces.push(workspacePath);
    expect(() => loadConfig(workspacePath)).toThrow(message);
  });

  it("loads profile custom limits", () => {
    const workspacePath = createTempWorkspace({ profile: { enabled: false, maxItemChars: 4000, maxTotalChars: 9000 } });
    workspaces.push(workspacePath);
    expect(loadConfig(workspacePath).profile).toEqual({ enabled: false, maxItemChars: 4000, maxTotalChars: 9000 });
  });

  it("defaults notifications to enabled with approved reasons and preserves overrides", () => {
    expect(createDefaultConfig().notifications).toEqual({
      enabled: true,
      reasons: ["approval_required", "waiting_user", "completed", "iteration_limit"],
    });

    const workspacePath = createTempWorkspace({ notifications: { enabled: false, reasons: ["completed"] } });
    workspaces.push(workspacePath);
    expect(loadConfig(workspacePath).notifications).toEqual({ enabled: false, reasons: ["completed"] });
  });
});

describe("multi-model configuration", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspacePath of workspaces.splice(0)) {
      removeTempWorkspace(workspacePath);
    }
  });

  it("loads explicit models and resolves the default profile", () => {
    const workspacePath = createTempWorkspace({
      models: [
        { id: "fast", name: "Fast", provider: "openai-chat", model: "gpt-4o-mini", apiUrl: "https://api.openai.com/v1", apiKey: "k" },
        { id: "local", name: "Local", provider: "local-llama", localModelId: "qwen3.5-4b-q4", contextSize: 32768 },
      ],
      defaultModelId: "local",
    });
    workspaces.push(workspacePath);

    const config = loadConfig(workspacePath);
    expect(config.models?.map((model) => model.id)).toEqual(["fast", "local"]);
    expect(config.defaultModelId).toBe("local");
    expect(resolveModelProfile(config)).toMatchObject({ id: "local", provider: "local-llama" });
    expect(resolveModelProfile(config, "fast")).toMatchObject({ id: "fast" });
    expect(() => resolveModelProfile(config, "missing")).toThrow("模型 missing 不存在");
  });

  it("normalizes legacy remote/local fields into model profiles", () => {
    const workspacePath = createTempWorkspace({
      remoteModel: { enabled: true },
      localModel: { enabled: true, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    });
    workspaces.push(workspacePath);

    const config = loadConfig(workspacePath);
    expect(config.models?.map((model) => model.id)).toEqual(["remote", "local"]);
    expect(config.models?.[0]).toMatchObject({ provider: "anthropic-messages", model: "test-model" });
  });

  it("rejects duplicate model ids", () => {
    const workspacePath = createTempWorkspace({
      models: [
        { id: "dup", provider: "openai-chat", model: "m", apiUrl: "u" },
        { id: "dup", provider: "openai-chat", model: "m2", apiUrl: "u2" },
      ],
    });
    workspaces.push(workspacePath);
    expect(() => loadConfig(workspacePath)).toThrow("id 重复");
  });

  it("rejects a defaultModelId that is not in models", () => {
    const workspacePath = createTempWorkspace({
      models: [{ id: "a", provider: "openai-chat", model: "m", apiUrl: "u" }],
      defaultModelId: "b",
    });
    workspaces.push(workspacePath);
    expect(() => loadConfig(workspacePath)).toThrow("defaultModelId 不在 models 中");
  });

  it("rejects unsupported providers and missing remote fields", () => {
    const badProvider = createTempWorkspace({ models: [{ id: "x", provider: "nope", model: "m", apiUrl: "u" }] });
    workspaces.push(badProvider);
    expect(() => loadConfig(badProvider)).toThrow("provider 不受支持");

    const missing = createTempWorkspace({ models: [{ id: "x", provider: "openai-chat" }] });
    workspaces.push(missing);
    expect(() => loadConfig(missing)).toThrow("models[0].model");
  });

  it("rejects unknown local model ids", () => {
    const workspacePath = createTempWorkspace({ models: [{ id: "l", provider: "local-llama", localModelId: "nope" }] });
    workspaces.push(workspacePath);
    expect(() => loadConfig(workspacePath)).toThrow("localModelId 不受支持");
  });

  it("normalizeConfigForApi derives legacy fields from the default model profile", () => {
    const normalized = normalizeConfigForApi({
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-legacy",
      model: "gpt-4o",
      modelProvider: "openai-chat",
      remoteModel: { enabled: true },
      localModel: { enabled: true, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
      defaultModelId: "local",
      debug: { enabled: false },
    });
    expect((normalized.models as Array<{ id: string }>).map((model) => model.id)).toEqual(["remote", "local"]);
    // 默认模型为 local：扁平字段从 local 派生，忽略 legacy 原值
    expect(normalized).toMatchObject({
      apiUrl: "",
      apiKey: "",
      model: "",
      modelProvider: "local-llama",
      remoteModel: { enabled: false },
      localModel: { enabled: true, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    });
    expect(normalized.defaultModelId).toBe("local");
    expect(normalized.debug).toEqual({ enabled: false });
  });

  it("restoreMaskedSecrets restores masked apiKeys by id instead of index", () => {
    const existing = {
      models: [
        { id: "a", apiKey: "sk-aaa-full" },
        { id: "b", apiKey: "sk-bbb-full" },
      ],
    };
    const masked = {
      models: [
        { id: "b", apiKey: "sk-b***" },
        { id: "a", apiKey: "sk-a***" },
      ],
    };
    const restored = restoreMaskedSecrets(masked, existing) as { models: Array<{ id: string; apiKey: string }> };
    expect(restored.models.map((model) => model.apiKey)).toEqual(["sk-bbb-full", "sk-aaa-full"]);
  });
});
