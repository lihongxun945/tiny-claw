import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCAL_MODELS } from "./model/local-catalog.js";
import { loadIdentity } from "./workspace/workspace.js";
import type { Config } from "./types.js";

const DEFAULTS: Partial<Config> = {
  maxTokens: 16384,
  maxContextTokens: 128000,
  contextCompressionThreshold: 0.7,
  contextCompressionMaxChars: 5000,
  contextCompressionToolResultMaxChars: 500,
  toolResultInitialMaxChars: 12_000,
  historyWindowSize: 5,
  maxAgentIterations: 20,
  searchProvider: "ollama",
};

export function createDefaultConfig(): Record<string, unknown> {
  return {
    remoteModel: { enabled: true },
    localModel: {
      enabled: false,
      modelId: "qwen3.5-4b-q4",
      contextSize: 32768,
    },
    apiUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    modelProvider: "openai-chat",
    maxTokens: DEFAULTS.maxTokens,
    maxContextTokens: DEFAULTS.maxContextTokens,
    contextCompressionThreshold: DEFAULTS.contextCompressionThreshold,
    contextCompressionMaxChars: DEFAULTS.contextCompressionMaxChars,
    contextCompressionToolResultMaxChars: DEFAULTS.contextCompressionToolResultMaxChars,
    toolResultInitialMaxChars: DEFAULTS.toolResultInitialMaxChars,
    historyWindowSize: DEFAULTS.historyWindowSize,
    maxAgentIterations: DEFAULTS.maxAgentIterations,
    sessionSummary: {
      enabled: true,
      persistent: true,
      turnThreshold: 5,
      recentTurns: 3,
      maxInputChars: 40000,
      maxChars: 10000,
      maxOutputTokens: 10000,
    },
    autoMemory: {
      enabled: true,
      mode: "hybrid",
      turnThreshold: 10,
      maxCandidates: 5,
      maxBatchChars: 8000,
      lockTimeoutSeconds: 300,
    },
    memory: {
      maxItemChars: 20000,
      maxTotalChars: 80000,
    },
    attachments: {
      enabled: true,
      maxFilesPerMessage: 4,
      maxFileSize: 10 * 1024 * 1024,
      allowedImageTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    },
    debug: {
      enabled: false,
      modelIO: false,
      rawStreamEvents: false,
    },
    security: {
      mode: "allow",
      tools: {},
      gateway: {
        host: "127.0.0.1",
        token: "",
        sseHeartbeatIntervalMs: 15000,
      },
      auditTools: true,
    },
    searchProvider: "duckduckgo",
    ollamaApiKey: "",
    searxngUrl: "",
    braveApiKey: "",
    subAgent: {
      allowedTools: ["web_search", "web_fetch", "file_read", "memory_list", "memory_read", "skill_list", "skill_use"],
      disabledTools: ["bash", "file_write", "file_edit", "memory_save", "memory_append", "memory_delete", "sub_agent_run"],
      maxIterations: 3,
      maxConcurrency: 3,
    },
    enabledPlugins: [],
    externalPlugins: [],
    plugins: {},
  };
}

export function ensureConfigFile(workspacePath: string): string {
  const configPath = resolve(workspacePath, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, "utf-8");
  }
  return configPath;
}

function assertString(value: unknown, key: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`配置字段 ${key} 必须是非空字符串`);
}

function assertNumber(value: unknown, key: string, options: { min: number; max?: number; integer?: boolean }): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`配置字段 ${key} 必须是数字`);
  if (options.integer && !Number.isInteger(value)) throw new Error(`配置字段 ${key} 必须是整数`);
  if (value < options.min || (options.max !== undefined && value > options.max)) {
    throw new Error(`配置字段 ${key} 超出允许范围`);
  }
}

function assertObject(value: unknown, key: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`配置字段 ${key} 必须是对象`);
}

function assertOptionalString(value: unknown, key: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`配置字段 ${key} 必须是字符串`);
}

function assertOptionalBoolean(value: unknown, key: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`配置字段 ${key} 必须是布尔值`);
}

function assertOptionalNumber(value: unknown, key: string, options: { min: number; max?: number; integer?: boolean }): void {
  if (value !== undefined) assertNumber(value, key, options);
}

function assertOptionalStringArray(value: unknown, key: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
    throw new Error(`配置字段 ${key} 必须是字符串数组`);
  }
}

export function validateConfig(raw: Record<string, unknown>): void {
  assertString(raw.apiUrl, "apiUrl");
  if (typeof raw.apiKey !== "string") throw new Error("配置字段 apiKey 必须是字符串");
  assertString(raw.model, "model");

  if (raw.remoteModel !== undefined) {
    assertObject(raw.remoteModel, "remoteModel");
    assertOptionalBoolean(raw.remoteModel.enabled, "remoteModel.enabled");
  }
  if (raw.localModel !== undefined) {
    assertObject(raw.localModel, "localModel");
    assertOptionalBoolean(raw.localModel.enabled, "localModel.enabled");
    const localModelId = raw.localModel.modelId;
    if (localModelId !== undefined && !LOCAL_MODELS.some((model) => model.id === String(localModelId))) {
      throw new Error("配置字段 localModel.modelId 不受支持");
    }
    assertOptionalNumber(raw.localModel.contextSize, "localModel.contextSize", { min: 512, max: 262144, integer: true });
  }
  const remoteEnabled = (raw.remoteModel as { enabled?: boolean } | undefined)?.enabled !== false;
  const localEnabled = (raw.localModel as { enabled?: boolean } | undefined)?.enabled === true;
  if (!remoteEnabled && !localEnabled) throw new Error("远程模型和本地模型至少需要启用一个");

  const modelProvider = raw.modelProvider ?? "anthropic-messages";
  if (!["anthropic-messages", "openai-chat", "chatgpt"].includes(String(modelProvider))) {
    throw new Error("配置字段 modelProvider 不受支持");
  }

  assertNumber(raw.maxTokens ?? DEFAULTS.maxTokens, "maxTokens", { min: 1, max: 1_000_000, integer: true });
  assertNumber(raw.maxContextTokens ?? DEFAULTS.maxContextTokens, "maxContextTokens", { min: 1, max: 10_000_000, integer: true });
  assertNumber(raw.contextCompressionThreshold ?? DEFAULTS.contextCompressionThreshold, "contextCompressionThreshold", { min: 0.1, max: 1 });
  assertNumber(raw.contextCompressionMaxChars ?? DEFAULTS.contextCompressionMaxChars, "contextCompressionMaxChars", { min: 100, max: 1_000_000, integer: true });
  assertNumber(raw.contextCompressionToolResultMaxChars ?? DEFAULTS.contextCompressionToolResultMaxChars, "contextCompressionToolResultMaxChars", { min: 100, max: 1_000_000, integer: true });
  assertNumber(raw.toolResultInitialMaxChars ?? DEFAULTS.toolResultInitialMaxChars, "toolResultInitialMaxChars", { min: 1000, max: 10_000_000, integer: true });
  assertNumber(raw.historyWindowSize ?? DEFAULTS.historyWindowSize, "historyWindowSize", { min: 0, max: 10_000, integer: true });
  assertNumber(raw.maxAgentIterations ?? DEFAULTS.maxAgentIterations, "maxAgentIterations", { min: 0, max: 1_000, integer: true });

  const searchProvider = raw.searchProvider ?? DEFAULTS.searchProvider;
  if (!["ollama", "searxng", "brave", "duckduckgo"].includes(String(searchProvider))) {
    throw new Error("配置字段 searchProvider 不受支持");
  }

  assertOptionalString(raw.ollamaApiKey, "ollamaApiKey");
  assertOptionalString(raw.searxngUrl, "searxngUrl");
  assertOptionalString(raw.braveApiKey, "braveApiKey");
  assertOptionalStringArray(raw.enabledPlugins, "enabledPlugins");
  assertOptionalStringArray(raw.externalPlugins, "externalPlugins");
  if (raw.plugins !== undefined) assertObject(raw.plugins, "plugins");

  if (raw.subAgent !== undefined) {
    assertObject(raw.subAgent, "subAgent");
    assertOptionalStringArray(raw.subAgent.allowedTools, "subAgent.allowedTools");
    assertOptionalStringArray(raw.subAgent.disabledTools, "subAgent.disabledTools");
    assertOptionalNumber(raw.subAgent.maxIterations, "subAgent.maxIterations", { min: 1, max: 8, integer: true });
    assertOptionalNumber(raw.subAgent.maxConcurrency, "subAgent.maxConcurrency", { min: 1, max: 8, integer: true });
  }

  if (raw.sessionSummary !== undefined) {
    assertObject(raw.sessionSummary, "sessionSummary");
    assertOptionalBoolean(raw.sessionSummary.enabled, "sessionSummary.enabled");
    assertOptionalBoolean(raw.sessionSummary.persistent, "sessionSummary.persistent");
    assertOptionalNumber(raw.sessionSummary.turnThreshold, "sessionSummary.turnThreshold", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.recentTurns, "sessionSummary.recentTurns", { min: 0, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxInputChars, "sessionSummary.maxInputChars", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxChars, "sessionSummary.maxChars", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxOutputTokens, "sessionSummary.maxOutputTokens", { min: 256, integer: true });
  }

  if (raw.autoMemory !== undefined) {
    assertObject(raw.autoMemory, "autoMemory");
    assertOptionalBoolean(raw.autoMemory.enabled, "autoMemory.enabled");
    if (raw.autoMemory.mode !== undefined && !["auto", "hybrid", "suggest"].includes(String(raw.autoMemory.mode))) {
      throw new Error("配置字段 autoMemory.mode 不受支持");
    }
    assertOptionalNumber(raw.autoMemory.turnThreshold, "autoMemory.turnThreshold", { min: 1, integer: true });
    assertOptionalNumber(raw.autoMemory.maxCandidates, "autoMemory.maxCandidates", { min: 1, integer: true });
    assertOptionalNumber(raw.autoMemory.maxBatchChars, "autoMemory.maxBatchChars", { min: 1, integer: true });
    assertOptionalNumber(raw.autoMemory.lockTimeoutSeconds, "autoMemory.lockTimeoutSeconds", { min: 1, integer: true });
  }

  if (raw.memory !== undefined) {
    assertObject(raw.memory, "memory");
    assertOptionalNumber(raw.memory.maxItemChars, "memory.maxItemChars", { min: 1000, integer: true });
    assertOptionalNumber(raw.memory.maxTotalChars, "memory.maxTotalChars", { min: 1000, integer: true });
    if (
      typeof raw.memory.maxItemChars === "number"
      && typeof raw.memory.maxTotalChars === "number"
      && raw.memory.maxItemChars > raw.memory.maxTotalChars
    ) {
      throw new Error("配置字段 memory.maxItemChars 不能大于 memory.maxTotalChars");
    }
  }

  if (raw.attachments !== undefined) {
    assertObject(raw.attachments, "attachments");
    assertOptionalBoolean(raw.attachments.enabled, "attachments.enabled");
    assertOptionalNumber(raw.attachments.maxFilesPerMessage, "attachments.maxFilesPerMessage", { min: 1, max: 20, integer: true });
    assertOptionalNumber(raw.attachments.maxFileSize, "attachments.maxFileSize", { min: 1, max: 100 * 1024 * 1024, integer: true });
    assertOptionalStringArray(raw.attachments.allowedImageTypes, "attachments.allowedImageTypes");
    const allowedTypes = raw.attachments.allowedImageTypes as unknown[] | undefined;
    if (allowedTypes?.some((value) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(value)))) {
      throw new Error("配置字段 attachments.allowedImageTypes 包含不支持的图片类型");
    }
  }

  if (raw.debug !== undefined && typeof raw.debug !== "boolean") {
    assertObject(raw.debug, "debug");
    assertOptionalBoolean(raw.debug.enabled, "debug.enabled");
    assertOptionalBoolean(raw.debug.modelIO, "debug.modelIO");
    assertOptionalBoolean(raw.debug.rawStreamEvents, "debug.rawStreamEvents");
  }

  if (raw.security !== undefined) {
    assertObject(raw.security, "security");
  }
  const security = raw.security as Config["security"];
  const securityMode = security?.mode;
  if (securityMode !== undefined && !["deny", "ask", "allow"].includes(securityMode)) {
    throw new Error("配置字段 security.mode 不受支持");
  }
  if (security?.tools !== undefined) {
    assertObject(security.tools, "security.tools");
    for (const [toolName, toolConfig] of Object.entries(security.tools)) {
      assertObject(toolConfig, `security.tools.${toolName}`);
      const toolSecurity = toolConfig as { mode?: unknown };
      const mode = toolSecurity.mode;
      if (mode !== undefined && (typeof mode !== "string" || !["deny", "ask", "allow"].includes(mode))) {
        throw new Error(`配置字段 security.tools.${toolName}.mode 不受支持`);
      }
    }
  }
  const gatewayHost = security?.gateway?.host;
  const gatewayToken = security?.gateway?.token;
  if (security?.gateway !== undefined) assertObject(security.gateway, "security.gateway");
  if (gatewayHost !== undefined && typeof gatewayHost !== "string") {
    throw new Error("配置字段 security.gateway.host 必须是字符串");
  }
  if (gatewayToken !== undefined && typeof gatewayToken !== "string") {
    throw new Error("配置字段 security.gateway.token 必须是字符串");
  }
  assertOptionalNumber(security?.gateway?.sseHeartbeatIntervalMs, "security.gateway.sseHeartbeatIntervalMs", {
    min: 1000,
    max: 60000,
    integer: true,
  });
  if (gatewayHost && gatewayHost !== "127.0.0.1" && gatewayHost !== "localhost" && gatewayHost !== "::1" && !gatewayToken) {
    throw new Error("Gateway 暴露到非回环地址时必须配置 security.gateway.token");
  }
  assertOptionalBoolean(security?.auditTools, "security.auditTools");
}

export function loadConfig(workspacePath: string): Config {
  const configPath = resolve(workspacePath, "config.json");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`无法读取配置文件: ${configPath}`);
  }

  if (!raw.apiUrl) throw new Error("配置缺少 apiUrl");
  if (raw.apiKey === undefined) throw new Error("配置缺少 apiKey");
  if (!raw.model) throw new Error("配置缺少 model");
  validateConfig(raw);

  return {
    remoteModel: (raw.remoteModel as Config["remoteModel"] | undefined) ?? { enabled: true },
    localModel: (raw.localModel as Config["localModel"] | undefined) ?? {
      enabled: false,
      modelId: "qwen3.5-4b-q4",
      contextSize: 32768,
    },
    apiUrl: raw.apiUrl as string,
    apiKey: raw.apiKey as string,
    model: raw.model as string,
    modelProvider: (raw.modelProvider as string | undefined) ?? "anthropic-messages",
    maxTokens: (raw.maxTokens as number) ?? DEFAULTS.maxTokens!,
    maxContextTokens: (raw.maxContextTokens as number) ?? DEFAULTS.maxContextTokens!,
    contextCompressionThreshold: (raw.contextCompressionThreshold as number) ?? DEFAULTS.contextCompressionThreshold!,
    contextCompressionMaxChars: (raw.contextCompressionMaxChars as number) ?? DEFAULTS.contextCompressionMaxChars!,
    contextCompressionToolResultMaxChars: (raw.contextCompressionToolResultMaxChars as number) ?? DEFAULTS.contextCompressionToolResultMaxChars!,
    toolResultInitialMaxChars: (raw.toolResultInitialMaxChars as number) ?? DEFAULTS.toolResultInitialMaxChars!,
    historyWindowSize: (raw.historyWindowSize as number) ?? DEFAULTS.historyWindowSize!,
    maxAgentIterations: (raw.maxAgentIterations as number) ?? DEFAULTS.maxAgentIterations!,
    searchProvider: (raw.searchProvider as Config["searchProvider"]) ?? DEFAULTS.searchProvider!,
    ollamaApiKey: raw.ollamaApiKey as string | undefined,
    searxngUrl: raw.searxngUrl as string | undefined,
    braveApiKey: raw.braveApiKey as string | undefined,
    enabledPlugins: raw.enabledPlugins as string[] | undefined,
    externalPlugins: raw.externalPlugins as string[] | undefined,
    plugins: raw.plugins as Record<string, Record<string, unknown>> | undefined,
    subAgent: raw.subAgent as Config["subAgent"] | undefined,
    sessionSummary: raw.sessionSummary as Config["sessionSummary"] | undefined,
    autoMemory: normalizeAutoMemoryConfig(raw.autoMemory),
    memory: raw.memory as Config["memory"] | undefined,
    attachments: raw.attachments as Config["attachments"] | undefined,
    debug: raw.debug as Config["debug"] | undefined,
    security: raw.security as Config["security"] | undefined,
    workspacePath,
    systemPrompt: loadIdentity(workspacePath),
  };
}

function normalizeAutoMemoryConfig(value: unknown): Config["autoMemory"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    mode: raw.mode === "auto" || raw.mode === "hybrid" || raw.mode === "suggest" ? raw.mode : undefined,
    turnThreshold: typeof raw.turnThreshold === "number" ? raw.turnThreshold : undefined,
    maxCandidates: typeof raw.maxCandidates === "number" ? raw.maxCandidates : undefined,
    maxBatchChars: typeof raw.maxBatchChars === "number" ? raw.maxBatchChars : undefined,
    lockTimeoutSeconds: typeof raw.lockTimeoutSeconds === "number" ? raw.lockTimeoutSeconds : undefined,
  };
}
