import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCAL_MODELS } from "./model/local-catalog.js";
import { loadIdentity } from "./workspace/workspace.js";
import type { Config, ModelProfile, ModelProvider } from "./types.js";
import { TOOL_CONTEXT_DEFAULTS, toolContextOptions } from "./tool-context.js";

const DEFAULTS: Partial<Config> = {
  maxTokens: 16384,
  maxContextTokens: 128000,
  contextCompressionThreshold: 0.8,
  contextCompressionTargetRatio: 0.2,
  bashTerminationGraceMs: 1000,
  bashMaxOutputChars: 10000,
  fileReadMaxChars: 20000,
  maxAgentIterations: 1000,
  emptyResponseRetries: 1,
  searchProvider: "duckduckgo",
};

const VALID_NOTIFICATION_REASONS = ["completed", "approval_required", "iteration_limit", "waiting_user", "interrupted"];

export function createDefaultConfig(): Record<string, unknown> {
  return {
    models: [
      {
        id: "deepseek",
        name: "DeepSeek",
        provider: "openai-chat",
        model: "deepseek-chat",
        apiUrl: "https://api.deepseek.com",
        apiKey: "",
      },
    ],
    defaultModelId: "deepseek",
    maxTokens: DEFAULTS.maxTokens,
    maxContextTokens: DEFAULTS.maxContextTokens,
    contextCompressionThreshold: DEFAULTS.contextCompressionThreshold,
    contextCompressionTargetRatio: DEFAULTS.contextCompressionTargetRatio,
    bashTerminationGraceMs: DEFAULTS.bashTerminationGraceMs,
    bashMaxOutputChars: DEFAULTS.bashMaxOutputChars,
    fileReadMaxChars: DEFAULTS.fileReadMaxChars,
    maxAgentIterations: DEFAULTS.maxAgentIterations,
    emptyResponseRetries: DEFAULTS.emptyResponseRetries,
    sessionSummary: {
      maxBatchesPerCompression: 3,
      maxCompressionDurationMs: 120000,
      recentBatchCount: 5,
      maxBatchTokens: 1500,
      maxBudgetRatio: 0.1,
      enabled: true,
      persistent: true,
      maxInputChars: 40000,
      maxOutputTokens: 10000,
      maxOperations: 32,
      maxItemChars: 1000,
      maxSourcesPerOperation: 8,
      checkpointDeltaThreshold: 20,
      checkpointMaxChars: 50000,
      recallMaxResults: 20,
      recallMaxOutputChars: 20000,
      recallMaxQueryChars: 500,
    },
    autoMemory: {
      enabled: true,
      mode: "hybrid",
      turnThreshold: 10,
      maxCandidates: 5,
      maxBatchChars: 8000,
      lockTimeoutSeconds: 300,
    },
    profile: {
      enabled: true,
      maxItemChars: 2000,
      maxTotalChars: 8000,
    },
    memory: {
      enabled: true,
      maxItemChars: 20000,
      maxTotalChars: 80000,
      retrieval: {
        maxResults: 5,
        candidateLimit: 20,
        maxContextChars: 6000,
        minScore: 0.35,
      },
      embedding: {
        provider: "local-hash",
        model: "local-hash-v1",
        dimensions: 384,
      },
      maintenance: {
        inactiveTurns: 200,
        inactiveDays: 30,
        trashRetentionDays: 30,
      },
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
      background: { timeoutSeconds: 3600, maxRunning: 4, maxLogChars: 20000 },
      mode: "auto",
      approvalTtlMs: 86400000,
      tools: {},
      gateway: {
        host: "127.0.0.1",
        token: "",
        sseHeartbeatIntervalMs: 15000,
      },
      auditTools: true,
    },
    project: {
      security: {
        mode: "auto",
        tools: {
          file_read: { mode: "allow" },
          file_write: { mode: "auto" },
          file_edit: { mode: "auto" },
          bash: { mode: "auto" },
          project_tree: { mode: "allow" },
          project_search: { mode: "allow" },
          git_status: { mode: "allow" },
          git_diff: { mode: "allow" },
        },
      },
      maxAgentIterations: 1000,
      gitTimeoutMs: 10000,
      diffMaxChars: 200000,
      openTimeoutMs: 30000,
      treeMaxDepth: 4,
      treeMaxEntries: 2000,
      searchMaxResults: 200,
      searchMaxChars: 50000,
      searchTimeoutMs: 10000,
    },
    plan: {
      enabled: true,
      maxSteps: 100,
    },
    progress: { enabled: true, silenceMs: 60000, toolCalls: 5 },
    notifications: {
      enabled: true,
      reasons: ["approval_required", "waiting_user", "completed", "iteration_limit"],
    },
    searchProvider: "duckduckgo",
    ollamaApiKey: "",
    searxngUrl: "",
    braveApiKey: "",
    subAgent: {
      allowedTools: ["web_search", "web_fetch", "file_read", "memory_list", "memory_search", "memory_read", "skill_list", "skill_use"],
      disabledTools: ["bash", "file_write", "file_edit", "memory_save", "memory_append", "memory_delete", "memory_restore", "sub_agent_run"],
      maxIterations: 100,
      maxConcurrency: 3,
    },
    enabledPlugins: [],
    externalPlugins: [],
    plugins: { "core-tool-context": { ...TOOL_CONTEXT_DEFAULTS } },
    pluginStates: {},
  };
}

export function stripDeprecatedConfigFields(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  for (const key of ["contextCompressionMaxChars", "contextCompressionToolResultMaxChars", "contextCompressionMaxOutputTokens", "toolResultInitialMaxChars", "historyWindowSize"]) delete result[key];
  const obsolete: Record<string, string[]> = {
    sessionSummary: ["turnThreshold", "maxChars", "recentTurns"],
    plan: ["maxGateCorrections", "decisionRetries"],
    project: ["historyWindowSize"],
    autoMemory: ["minConfidence"],
  };
  for (const [section, keys] of Object.entries(obsolete)) {
    const value = result[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const copy = { ...value } as Record<string, unknown>;
    for (const key of keys) delete copy[key];
    result[section] = copy;
  }
  return result;
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
  if (Array.isArray(raw.models) && raw.models.length === 0) {
    throw new Error("至少需要配置一个模型");
  }
  const hasExplicitModels = Array.isArray(raw.models) && raw.models.length > 0;

  // 顶层 apiUrl/apiKey/model：旧配置必填；使用 models 数组时改为可选（models 内逐个校验）
  if (hasExplicitModels) {
    if (raw.apiUrl !== undefined) assertString(raw.apiUrl, "apiUrl");
    if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") throw new Error("配置字段 apiKey 必须是字符串");
    if (raw.model !== undefined) assertString(raw.model, "model");
  } else {
    assertString(raw.apiUrl, "apiUrl");
    if (typeof raw.apiKey !== "string") throw new Error("配置字段 apiKey 必须是字符串");
    assertString(raw.model, "model");
  }

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

  if (hasExplicitModels) {
    validateModelProfiles(raw.models);
    const defaultModelId = raw.defaultModelId;
    if (defaultModelId !== undefined && !(raw.models as Array<{ id?: unknown }>).some((item) => item?.id === String(defaultModelId))) {
      throw new Error("配置字段 defaultModelId 不在 models 中");
    }
  } else {
    const remoteEnabled = (raw.remoteModel as { enabled?: boolean } | undefined)?.enabled !== false;
    const localEnabled = (raw.localModel as { enabled?: boolean } | undefined)?.enabled === true;
    if (!remoteEnabled && !localEnabled) throw new Error("远程模型和本地模型至少需要启用一个");
  }

  const modelProvider = raw.modelProvider ?? "anthropic-messages";
  if (!["anthropic-messages", "openai-chat", "chatgpt"].includes(String(modelProvider))) {
    throw new Error("配置字段 modelProvider 不受支持");
  }

  assertNumber(raw.maxTokens ?? DEFAULTS.maxTokens, "maxTokens", { min: 1, max: 1_000_000, integer: true });
  assertNumber(raw.maxContextTokens ?? DEFAULTS.maxContextTokens, "maxContextTokens", { min: 1, max: 10_000_000, integer: true });
  const trigger = raw.contextCompressionThreshold ?? DEFAULTS.contextCompressionThreshold;
  const target = raw.contextCompressionTargetRatio ?? DEFAULTS.contextCompressionTargetRatio;
  assertNumber(trigger, "contextCompressionThreshold", { min: 0, max: 1 });
  assertNumber(target, "contextCompressionTargetRatio", { min: 0, max: 1 });
  if (!(Number(target) > 0 && Number(target) < Number(trigger) && Number(trigger) < 1)) {
    throw new Error("上下文压缩阈值必须满足：0 < 目标阈值 < 触发阈值 < 1");
  }
  if (raw.sessionSummary === undefined && Number(target) < 0.1) {
    throw new Error("摘要预算比例必须大于 0 且不超过压缩目标阈值");
  }
  assertNumber(raw.bashTerminationGraceMs ?? DEFAULTS.bashTerminationGraceMs, "bashTerminationGraceMs", { min: 0, max: 60000, integer: true });
  assertOptionalNumber(raw.bashMaxOutputChars, "bashMaxOutputChars", { min: 1, integer: true });
  assertOptionalNumber(raw.fileReadMaxChars, "fileReadMaxChars", { min: 1, integer: true });
  assertNumber(raw.maxAgentIterations ?? DEFAULTS.maxAgentIterations, "maxAgentIterations", { min: 0, max: 1_000, integer: true });
  assertNumber(raw.emptyResponseRetries ?? DEFAULTS.emptyResponseRetries, "emptyResponseRetries", { min: 0, max: 5, integer: true });

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
  toolContextOptions({ plugins: raw.plugins } as Config);
  if (raw.pluginStates !== undefined) {
    assertObject(raw.pluginStates, "pluginStates");
    for (const [id, state] of Object.entries(raw.pluginStates)) {
      assertObject(state, `pluginStates.${id}`);
      assertOptionalBoolean(state.enabled, `pluginStates.${id}.enabled`);
    }
  }

  if (raw.subAgent !== undefined) {
    assertObject(raw.subAgent, "subAgent");
    assertOptionalStringArray(raw.subAgent.allowedTools, "subAgent.allowedTools");
    assertOptionalStringArray(raw.subAgent.disabledTools, "subAgent.disabledTools");
    assertOptionalNumber(raw.subAgent.maxIterations, "subAgent.maxIterations", { min: 1, max: 100, integer: true });
    assertOptionalNumber(raw.subAgent.maxConcurrency, "subAgent.maxConcurrency", { min: 1, max: 8, integer: true });
  }

  if (raw.sessionSummary !== undefined) {
    assertObject(raw.sessionSummary, "sessionSummary");
    assertOptionalBoolean(raw.sessionSummary.enabled, "sessionSummary.enabled");
    assertOptionalBoolean(raw.sessionSummary.persistent, "sessionSummary.persistent");
    assertOptionalNumber(raw.sessionSummary.maxInputChars, "sessionSummary.maxInputChars", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxOutputTokens, "sessionSummary.maxOutputTokens", { min: 256, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxOperations, "sessionSummary.maxOperations", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxItemChars, "sessionSummary.maxItemChars", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxSourcesPerOperation, "sessionSummary.maxSourcesPerOperation", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.checkpointDeltaThreshold, "sessionSummary.checkpointDeltaThreshold", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.checkpointMaxChars, "sessionSummary.checkpointMaxChars", { min: 1000, integer: true });
    assertOptionalNumber(raw.sessionSummary.recentBatchCount, "sessionSummary.recentBatchCount", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxBatchesPerCompression, "sessionSummary.maxBatchesPerCompression", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxCompressionDurationMs, "sessionSummary.maxCompressionDurationMs", { min: 1, max: 2147483647, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxBatchTokens, "sessionSummary.maxBatchTokens", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.maxBudgetRatio, "sessionSummary.maxBudgetRatio", { min: 0, max: 1 });
    const summaryRatio = Number(raw.sessionSummary.maxBudgetRatio ?? 0.1);
    if (!(summaryRatio > 0 && summaryRatio <= Number(target))) throw new Error("摘要预算比例必须大于 0 且不超过压缩目标阈值");
    assertOptionalNumber(raw.sessionSummary.recallMaxResults, "sessionSummary.recallMaxResults", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.recallMaxOutputChars, "sessionSummary.recallMaxOutputChars", { min: 1, integer: true });
    assertOptionalNumber(raw.sessionSummary.recallMaxQueryChars, "sessionSummary.recallMaxQueryChars", { min: 1, integer: true });
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
    assertOptionalBoolean(raw.memory.enabled, "memory.enabled");
    assertOptionalNumber(raw.memory.maxItemChars, "memory.maxItemChars", { min: 1000, integer: true });
    assertOptionalNumber(raw.memory.maxTotalChars, "memory.maxTotalChars", { min: 1000, integer: true });
    if (
      typeof raw.memory.maxItemChars === "number"
      && typeof raw.memory.maxTotalChars === "number"
      && raw.memory.maxItemChars > raw.memory.maxTotalChars
    ) {
      throw new Error("配置字段 memory.maxItemChars 不能大于 memory.maxTotalChars");
    }
    if (raw.memory.retrieval !== undefined) {
      assertObject(raw.memory.retrieval, "memory.retrieval");
      assertOptionalNumber(raw.memory.retrieval.maxResults, "memory.retrieval.maxResults", { min: 1, integer: true });
      assertOptionalNumber(raw.memory.retrieval.candidateLimit, "memory.retrieval.candidateLimit", { min: 1, integer: true });
      assertOptionalNumber(raw.memory.retrieval.maxContextChars, "memory.retrieval.maxContextChars", { min: 100, integer: true });
      assertOptionalNumber(raw.memory.retrieval.minScore, "memory.retrieval.minScore", { min: 0, max: 1 });
    }
    if (raw.memory.embedding !== undefined) {
      assertObject(raw.memory.embedding, "memory.embedding");
      if (raw.memory.embedding.provider !== undefined && !["local-hash", "openai-compatible"].includes(String(raw.memory.embedding.provider))) {
        throw new Error("配置字段 memory.embedding.provider 不受支持");
      }
      if (raw.memory.embedding.provider === "openai-compatible") {
        assertString(raw.memory.embedding.model, "memory.embedding.model");
        assertNumber(raw.memory.embedding.dimensions, "memory.embedding.dimensions", { min: 8, integer: true });
      }
      if (raw.memory.embedding.model !== undefined) assertString(raw.memory.embedding.model, "memory.embedding.model");
      assertOptionalNumber(raw.memory.embedding.dimensions, "memory.embedding.dimensions", { min: 8, integer: true });
      assertOptionalString(raw.memory.embedding.apiUrl, "memory.embedding.apiUrl");
      assertOptionalString(raw.memory.embedding.apiKey, "memory.embedding.apiKey");
    }
    if (raw.memory.maintenance !== undefined) {
      assertObject(raw.memory.maintenance, "memory.maintenance");
      assertOptionalNumber(raw.memory.maintenance.inactiveTurns, "memory.maintenance.inactiveTurns", { min: 1, integer: true });
      assertOptionalNumber(raw.memory.maintenance.inactiveDays, "memory.maintenance.inactiveDays", { min: 1, integer: true });
      assertOptionalNumber(raw.memory.maintenance.trashRetentionDays, "memory.maintenance.trashRetentionDays", { min: 1, integer: true });
    }
  }

  if (raw.profile !== undefined) {
    assertObject(raw.profile, "profile");
    assertOptionalBoolean(raw.profile.enabled, "profile.enabled");
    assertOptionalNumber(raw.profile.maxItemChars, "profile.maxItemChars", { min: 100, integer: true });
    assertOptionalNumber(raw.profile.maxTotalChars, "profile.maxTotalChars", { min: 100, integer: true });
    if (
      typeof raw.profile.maxItemChars === "number"
      && typeof raw.profile.maxTotalChars === "number"
      && raw.profile.maxItemChars > raw.profile.maxTotalChars
    ) throw new Error("配置字段 profile.maxItemChars 不能大于 profile.maxTotalChars");
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
  if (security?.background !== undefined) {
    assertObject(security.background, "security.background");
    assertOptionalNumber(security.background.timeoutSeconds, "security.background.timeoutSeconds", { min: 1, max: 86400, integer: true });
    assertOptionalNumber(security.background.maxRunning, "security.background.maxRunning", { min: 1, max: 100, integer: true });
    assertOptionalNumber(security.background.maxLogChars, "security.background.maxLogChars", { min: 1000, max: 1000000, integer: true });
  }
  if (security?.trustedProjects !== undefined) {
    if (!Array.isArray(security.trustedProjects) || security.trustedProjects.some((path) => typeof path !== "string" || !path.startsWith("/"))) {
      throw new Error("配置字段 security.trustedProjects 必须是项目绝对路径数组");
    }
  }
  const securityMode = security?.mode;
  if (securityMode !== undefined && !["ask", "auto", "allow"].includes(securityMode)) {
    throw new Error("配置字段 security.mode 不受支持");
  }
  if (security?.tools !== undefined) {
    assertObject(security.tools, "security.tools");
    for (const [toolName, toolConfig] of Object.entries(security.tools)) {
      assertObject(toolConfig, `security.tools.${toolName}`);
      const toolSecurity = toolConfig as { mode?: unknown };
      const mode = toolSecurity.mode;
      if (mode !== undefined && (typeof mode !== "string" || !["ask", "auto", "allow"].includes(mode))) {
        throw new Error(`配置字段 security.tools.${toolName}.mode 不受支持`);
      }
    }
  }
  assertOptionalNumber(security?.approvalTtlMs, "security.approvalTtlMs", { min: 1000, max: 86_400_000, integer: true });
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

  if (raw.project !== undefined) {
    assertObject(raw.project, "project");
    const project = raw.project as Record<string, unknown>;
    if (project.security !== undefined) {
      assertObject(project.security, "project.security");
      const projectSecurity = project.security as Record<string, unknown>;
      if (projectSecurity.mode !== undefined && !["ask", "auto", "allow"].includes(String(projectSecurity.mode))) {
        throw new Error("配置字段 project.security.mode 不受支持");
      }
      if (projectSecurity.tools !== undefined) {
        assertObject(projectSecurity.tools, "project.security.tools");
        for (const [toolName, toolConfig] of Object.entries(projectSecurity.tools)) {
          assertObject(toolConfig, `project.security.tools.${toolName}`);
        const toolSecurity = toolConfig as { mode?: unknown };
        const mode = toolSecurity.mode;
        if (mode !== undefined && (typeof mode !== "string" || !["ask", "auto", "allow"].includes(mode))) {
            throw new Error(`配置字段 project.security.tools.${toolName}.mode 不受支持`);
          }
        }
      }
    }
    assertOptionalNumber(project.maxAgentIterations, "project.maxAgentIterations", { min: 0, max: 1_000, integer: true });
    assertOptionalNumber(project.gitTimeoutMs, "project.gitTimeoutMs", { min: 1000, max: 120_000, integer: true });
    assertOptionalNumber(project.diffMaxChars, "project.diffMaxChars", { min: 1000, max: 5_000_000, integer: true });
    assertOptionalNumber(project.openTimeoutMs, "project.openTimeoutMs", { min: 1000, max: 120_000, integer: true });
    assertOptionalNumber(project.treeMaxDepth, "project.treeMaxDepth", { min: 1, max: 20, integer: true });
    assertOptionalNumber(project.treeMaxEntries, "project.treeMaxEntries", { min: 10, max: 100_000, integer: true });
    assertOptionalNumber(project.searchMaxResults, "project.searchMaxResults", { min: 1, max: 10_000, integer: true });
    assertOptionalNumber(project.searchMaxChars, "project.searchMaxChars", { min: 1000, max: 5_000_000, integer: true });
    assertOptionalNumber(project.searchTimeoutMs, "project.searchTimeoutMs", { min: 1000, max: 120_000, integer: true });
  }
  if (raw.plan !== undefined) {
    assertObject(raw.plan, "plan");
    const plan = raw.plan as Record<string, unknown>;
    assertOptionalBoolean(plan.enabled, "plan.enabled");
    assertOptionalNumber(plan.maxSteps, "plan.maxSteps", { min: 1, max: 100, integer: true });
  }
  if (raw.progress !== undefined) {
    assertObject(raw.progress, "progress");
    const progress = raw.progress as Record<string, unknown>;
    assertOptionalBoolean(progress.enabled, "progress.enabled");
    assertOptionalNumber(progress.silenceMs, "progress.silenceMs", { min: 1, integer: true });
    assertOptionalNumber(progress.toolCalls, "progress.toolCalls", { min: 1, integer: true });
  }
  if (raw.notifications !== undefined) {
    assertObject(raw.notifications, "notifications");
    const notifications = raw.notifications as Record<string, unknown>;
    assertOptionalBoolean(notifications.enabled, "notifications.enabled");
    assertOptionalStringArray(notifications.reasons, "notifications.reasons");
    const reasons = notifications.reasons as unknown[] | undefined;
    if (reasons?.some((value) => !VALID_NOTIFICATION_REASONS.includes(String(value)))) {
      throw new Error("配置字段 notifications.reasons 包含不支持的触发类型");
    }
  }
}

export function loadConfig(workspacePath: string): Config {
  const configPath = resolve(workspacePath, "config.json");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`无法读取配置文件: ${configPath}`);
  }

  raw = stripDeprecatedConfigFields(raw);

  const hasExplicitModels = Array.isArray(raw.models) && raw.models.length > 0;
  if (!hasExplicitModels) {
    if (!raw.apiUrl) throw new Error("配置缺少 apiUrl");
    if (raw.apiKey === undefined) throw new Error("配置缺少 apiKey");
    if (!raw.model) throw new Error("配置缺少 model");
  }
  validateConfig(raw);

  const models = normalizeModels(raw);
  const defaultModelId = (raw.defaultModelId as string | undefined) ?? models[0]?.id;
  const defaultProfile = models.find((item) => item.id === defaultModelId) ?? models[0];

  return {
    remoteModel: { enabled: defaultProfile?.provider !== "local-llama" },
    localModel: defaultProfile?.provider === "local-llama"
      ? {
          enabled: true,
          modelId: (defaultProfile.localModelId ?? "qwen3.5-4b-q4") as ModelProfile["localModelId"],
          contextSize: defaultProfile.contextSize,
        }
      : { enabled: false },
    apiUrl: defaultProfile?.apiUrl ?? "",
    apiKey: defaultProfile?.apiKey ?? "",
    model: defaultProfile?.model ?? "",
    modelProvider: defaultProfile?.provider ?? "anthropic-messages",
    models,
    defaultModelId,
    maxTokens: (raw.maxTokens as number) ?? DEFAULTS.maxTokens!,
    maxContextTokens: (raw.maxContextTokens as number) ?? DEFAULTS.maxContextTokens!,
    contextCompressionThreshold: (raw.contextCompressionThreshold as number) ?? DEFAULTS.contextCompressionThreshold!,
    contextCompressionTargetRatio: (raw.contextCompressionTargetRatio as number) ?? DEFAULTS.contextCompressionTargetRatio!,
    bashTerminationGraceMs: (raw.bashTerminationGraceMs as number) ?? DEFAULTS.bashTerminationGraceMs!,
    bashMaxOutputChars: (raw.bashMaxOutputChars as number) ?? DEFAULTS.bashMaxOutputChars!,
    fileReadMaxChars: (raw.fileReadMaxChars as number) ?? DEFAULTS.fileReadMaxChars!,
    maxAgentIterations: (raw.maxAgentIterations as number) ?? DEFAULTS.maxAgentIterations!,
    emptyResponseRetries: (raw.emptyResponseRetries as number) ?? DEFAULTS.emptyResponseRetries!,
    searchProvider: (raw.searchProvider as Config["searchProvider"]) ?? DEFAULTS.searchProvider!,
    ollamaApiKey: raw.ollamaApiKey as string | undefined,
    searxngUrl: raw.searxngUrl as string | undefined,
    braveApiKey: raw.braveApiKey as string | undefined,
    enabledPlugins: raw.enabledPlugins as string[] | undefined,
    externalPlugins: raw.externalPlugins as string[] | undefined,
    plugins: raw.plugins as Record<string, Record<string, unknown>> | undefined,
    pluginStates: raw.pluginStates as Record<string, { enabled?: boolean }> | undefined,
    subAgent: raw.subAgent as Config["subAgent"] | undefined,
    sessionSummary: raw.sessionSummary as Config["sessionSummary"] | undefined,
    autoMemory: normalizeAutoMemoryConfig(raw.autoMemory),
    profile: raw.profile as Config["profile"] | undefined,
    memory: raw.memory as Config["memory"] | undefined,
    attachments: raw.attachments as Config["attachments"] | undefined,
    debug: raw.debug as Config["debug"] | undefined,
    security: raw.security as Config["security"] | undefined,
    project: raw.project as Config["project"] | undefined,
    plan: raw.plan as Config["plan"] | undefined,
    progress: raw.progress as Config["progress"] | undefined,
    notifications: raw.notifications as Config["notifications"] | undefined,
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

function validateModelProfiles(value: unknown): asserts value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("配置字段 models 必须是数组");
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const prefix = `models[${index}]`;
    assertObject(item, prefix);
    assertString(item.id, `${prefix}.id`);
    if (seen.has(String(item.id))) throw new Error(`配置字段 ${prefix}.id 重复`);
    seen.add(String(item.id));
    if (item.name !== undefined && typeof item.name !== "string") throw new Error(`配置字段 ${prefix}.name 必须是字符串`);
    if (typeof item.provider !== "string" || !["anthropic-messages", "openai-chat", "chatgpt", "local-llama"].includes(item.provider)) {
      throw new Error(`配置字段 ${prefix}.provider 不受支持`);
    }
    const provider = item.provider as ModelProvider;
    if (provider === "local-llama") {
      const localModelId = item.localModelId;
      if (typeof localModelId !== "string" || !LOCAL_MODELS.some((model) => model.id === localModelId)) {
        throw new Error(`配置字段 ${prefix}.localModelId 不受支持`);
      }
      assertOptionalNumber(item.contextSize, `${prefix}.contextSize`, { min: 512, max: 262144, integer: true });
    } else {
      assertString(item.model, `${prefix}.model`);
      assertString(item.apiUrl, `${prefix}.apiUrl`);
      if (item.apiKey !== undefined && typeof item.apiKey !== "string") throw new Error(`配置字段 ${prefix}.apiKey 必须是字符串`);
    }
    assertOptionalNumber(item.maxTokens, `${prefix}.maxTokens`, { min: 1, max: 1_000_000, integer: true });
  }
}

function normalizeModels(raw: Record<string, unknown>): ModelProfile[] {
  const explicit = Array.isArray(raw.models) && raw.models.length > 0
    ? (raw.models as Array<Record<string, unknown>>).map(normalizeModelProfile)
    : [];
  const remoteEnabled = (raw.remoteModel as { enabled?: boolean } | undefined)?.enabled !== false;
  const localEnabled = (raw.localModel as { enabled?: boolean } | undefined)?.enabled === true;
  const profiles: ModelProfile[] = [...explicit];
  if (explicit.length === 0 && remoteEnabled) {
    profiles.push({
      id: "remote",
      name: "远程模型",
      provider: (raw.modelProvider ?? "anthropic-messages") as ModelProvider,
      model: raw.model as string,
      apiUrl: raw.apiUrl as string,
      apiKey: raw.apiKey as string,
    });
  }
  if (localEnabled && !profiles.some((item) => item.provider === "local-llama")) {
    const local = raw.localModel as { modelId?: string; contextSize?: number } | undefined;
    profiles.push({
      id: "local",
      name: "本地模型",
      provider: "local-llama",
      localModelId: (local?.modelId ?? "qwen3.5-4b-q4") as ModelProfile["localModelId"],
      contextSize: local?.contextSize,
    });
  }
  return profiles;
}

function normalizeModelProfile(item: Record<string, unknown>): ModelProfile {
  const provider = String(item.provider) as ModelProvider;
  return {
    id: String(item.id),
    name: typeof item.name === "string" ? item.name : undefined,
    provider,
    model: typeof item.model === "string" ? item.model : undefined,
    apiUrl: typeof item.apiUrl === "string" ? item.apiUrl : undefined,
    apiKey: typeof item.apiKey === "string" ? item.apiKey : undefined,
    localModelId: typeof item.localModelId === "string" ? item.localModelId as ModelProfile["localModelId"] : undefined,
    contextSize: typeof item.contextSize === "number" ? item.contextSize : undefined,
    maxTokens: typeof item.maxTokens === "number" ? item.maxTokens : undefined,
  };
}

/**
 * 将 config.json 的原始内容归一化，供配置 API（GET/PUT /config）读写。
 * models 数组为唯一权威：扁平字段（apiUrl/apiKey/model/modelProvider/remoteModel/localModel）
 * 一律从默认模型 profile 派生，忽略 raw 中的 legacy 原值。
 */
export function normalizeConfigForApi(raw: Record<string, unknown>): Record<string, unknown> {
  const models = normalizeModels(raw);
  const normalized: Record<string, unknown> = { ...raw };
  normalized.models = models;
  const defaultModelId = typeof raw.defaultModelId === "string" ? raw.defaultModelId : undefined;
  if (defaultModelId && !models.some((item) => item.id === defaultModelId)) {
    delete normalized.defaultModelId;
  }
  const profile = models.find((item) => item.id === defaultModelId) ?? models[0];
  // models 数组为唯一权威：扁平字段一律从默认模型派生，忽略 legacy 原值
  normalized.apiUrl = profile?.apiUrl ?? "";
  normalized.apiKey = profile?.apiKey ?? "";
  normalized.model = profile?.model ?? "";
  normalized.modelProvider = profile?.provider ?? "anthropic-messages";
  normalized.remoteModel = { enabled: profile?.provider !== "local-llama" };
  normalized.localModel =
    profile?.provider === "local-llama"
      ? { enabled: true, modelId: profile.localModelId, contextSize: profile.contextSize }
      : { enabled: false };
  return normalized;
}

export function resolveModelProfile(config: Config, modelId?: string): ModelProfile {
  const models = config.models ?? [];
  if (models.length === 0) throw new Error("没有配置任何模型");
  if (modelId) {
    const found = models.find((item) => item.id === modelId);
    if (found) return found;
    throw new Error(`模型 ${modelId} 不存在`);
  }
  const defaultId = config.defaultModelId;
  if (defaultId) {
    const found = models.find((item) => item.id === defaultId);
    if (found) return found;
  }
  return models[0];
}

export function applyModelProfileToConfig(config: Config, profile: ModelProfile): Config {
  return {
    ...config,
    apiUrl: profile.apiUrl ?? config.apiUrl,
    apiKey: profile.apiKey ?? config.apiKey,
    model: profile.model ?? config.model,
    modelProvider: profile.provider,
    remoteModel: { enabled: profile.provider !== "local-llama" },
    localModel: profile.provider === "local-llama"
      ? { enabled: true, modelId: profile.localModelId, contextSize: profile.contextSize }
      : { enabled: false },
    maxTokens: profile.maxTokens ?? config.maxTokens,
  };
}

const CONFIG_SECRET_KEY = /(key|secret|token|password)$/i;

export function maskConfigSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return CONFIG_SECRET_KEY.test(key) && value ? `${value.slice(0, 4)}***` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskConfigSecrets(item));
  }
  if (value && typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      masked[childKey] = maskConfigSecrets(childValue, childKey);
    }
    return masked;
  }
  return value;
}

export function restoreMaskedSecrets(value: unknown, existing: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (CONFIG_SECRET_KEY.test(key) && value.endsWith("***")) return existing;
    return value;
  }
  if (Array.isArray(value)) {
    const existingItems = Array.isArray(existing) ? existing : [];
    const allHaveId = value.length > 0 && value.every((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string");
    if (allHaveId) {
      const byId = new Map<string, unknown>();
      for (const item of existingItems) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const id = (item as Record<string, unknown>).id;
          if (typeof id === "string") byId.set(id, item);
        }
      }
      return value.map((item) => restoreMaskedSecrets(item, byId.get((item as Record<string, unknown>).id as string)));
    }
    return value.map((item, index) => restoreMaskedSecrets(item, existingItems[index]));
  }
  if (value && typeof value === "object") {
    const existingRecord = existing && typeof existing === "object" ? existing as Record<string, unknown> : {};
    const restored: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      restored[childKey] = restoreMaskedSecrets(childValue, existingRecord[childKey], childKey);
    }
    return restored;
  }
  return value;
}
