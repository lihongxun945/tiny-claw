import { useCallback, useEffect, useState } from "react";
import { downloadLocalModel, fetchConfigSettings, fetchLocalModels, testModel, updateConfig, type LocalModelStatus } from "../lib/api.js";
import ModelProfilesEditor from "./ModelProfilesEditor.js";
import type { ModelProfile } from "../types.js";

type FieldType = "text" | "password" | "number" | "percent" | "select" | "checkbox" | "list" | "json";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  optionLabels?: Record<string, string>;

  required?: boolean;
  description?: string;
}

interface FieldGroup {
  title: string;
  fields: FieldDef[];
}

function getValue(config: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, config);
}

function setValue(config: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [key, ...rest] = path.split(".");
  if (rest.length === 0) return { ...config, [key]: value };
  const current = config[key];
  const nested = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return { ...config, [key]: setValue(nested, rest.join("."), value) };
}

function normalizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.debug === "boolean") {
    return { ...config, debug: { enabled: config.debug } };
  }
  return config;
}

function formatDraft(value: unknown, type: FieldType): string {
  if (type === "list") return Array.isArray(value) ? value.join("\n") : "";
  if (type === "json") return JSON.stringify(value ?? {}, null, 2);
  return "";
}

function parseList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readProfiles(value: unknown): ModelProfile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    id: String(item.id ?? ""),
    name: typeof item.name === "string" ? item.name : undefined,
    provider: (item.provider ?? "anthropic-messages") as ModelProfile["provider"],
    model: typeof item.model === "string" ? item.model : undefined,
    apiUrl: typeof item.apiUrl === "string" ? item.apiUrl : undefined,
    apiKey: typeof item.apiKey === "string" ? item.apiKey : undefined,
    localModelId: typeof item.localModelId === "string" ? item.localModelId : undefined,
    contextSize: typeof item.contextSize === "number" ? item.contextSize : undefined,
    maxTokens: typeof item.maxTokens === "number" ? item.maxTokens : undefined,
  }));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gigabytes = bytes / (1024 ** 3);
  if (gigabytes >= 1) return `${gigabytes.toFixed(2)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

const FIELD_GROUPS: FieldGroup[] = [
  {
    title: "上下文与执行",
    fields: [
      { key: "maxTokens", label: "单次回复 Token", type: "number" },
      { key: "emptyResponseRetries", label: "空响应重试次数", type: "number" },
      { key: "maxContextTokens", label: "上下文 Token 上限", type: "number" },
      { key: "contextCompressionThreshold", label: "上下文压缩触发阈值（%）", type: "percent" },
      { key: "contextCompressionTargetRatio", label: "压缩目标（%，必须小于触发阈值）", type: "percent" },
      { key: "fileReadMaxChars", label: "文件读取输出字符上限", type: "number" },
      { key: "bashMaxOutputChars", label: "命令单路输出字符上限", type: "number" },
      { key: "maxAgentIterations", label: "最大 Agent 迭代", type: "number", description: "达到上限时任务会停止并明确提示；设置为 0 表示不限制。" },
    ],
  },
  {
    title: "会话摘要",
    fields: [
      { key: "sessionSummary.enabled", label: "启用", type: "checkbox" },
      { key: "sessionSummary.persistent", label: "持久化", type: "checkbox" },
      { key: "sessionSummary.maxInputChars", label: "摘要请求输入字符上限", type: "number" },
      { key: "sessionSummary.maxOutputTokens", label: "摘要输出 Token 上限", type: "number" },
    ],
  },
  {
    title: "会话摘要高级设置",
    fields: [
      { key: "sessionSummary.maxOperations", label: "单次最大变更数", type: "number" },
      { key: "sessionSummary.maxItemChars", label: "单条摘要字符上限", type: "number" },
      { key: "sessionSummary.maxSourcesPerOperation", label: "单次变更最大来源数", type: "number" },
      { key: "sessionSummary.checkpointDeltaThreshold", label: "摘要存储整理批次阈值", type: "number" },
      { key: "sessionSummary.checkpointMaxChars", label: "摘要存储整理字符阈值", type: "number" },
      { key: "sessionSummary.recentBatchCount", label: "最近摘要批次数", type: "number" },
      { key: "sessionSummary.maxBatchesPerCompression", label: "单次压缩最多批次", type: "number" },
      { key: "sessionSummary.maxCompressionDurationMs", label: "单次压缩总耗时上限（毫秒）", type: "number" },
      { key: "sessionSummary.maxBatchTokens", label: "单批摘要 Token 上限", type: "number" },
      { key: "sessionSummary.maxBudgetRatio", label: "摘要预算（%，不超过压缩目标）", type: "percent" },
      { key: "sessionSummary.recallMaxResults", label: "原文召回条数上限", type: "number" },
      { key: "sessionSummary.recallMaxOutputChars", label: "原文召回输出上限", type: "number" },
      { key: "sessionSummary.recallMaxQueryChars", label: "原文检索词长度上限", type: "number" },
    ],
  },
  {
    title: "自动记忆",
    fields: [
      { key: "autoMemory.enabled", label: "启用", type: "checkbox" },
      { key: "autoMemory.mode", label: "整理模式", type: "select", options: ["auto", "hybrid", "suggest"] },
      { key: "autoMemory.turnThreshold", label: "整理轮数阈值", type: "number" },
      { key: "autoMemory.maxCandidates", label: "最大工具调用次数", type: "number" },
      { key: "autoMemory.maxBatchChars", label: "整理输入字符上限", type: "number" },
      { key: "autoMemory.lockTimeoutSeconds", label: "整理锁超时（秒）", type: "number" },
      { key: "profile.enabled", label: "启用固定 Profile", type: "checkbox", description: "稳定用户身份、偏好和长期约束会在每轮固定注入。" },
      { key: "profile.maxItemChars", label: "单条 Profile 字符上限", type: "number" },
      { key: "profile.maxTotalChars", label: "全部 Profile 字符上限", type: "number" },
      { key: "memory.enabled", label: "启用向量长期记忆", type: "checkbox" },
      { key: "memory.embedding.provider", label: "Embedding 提供方", type: "select", options: ["local-hash", "openai-compatible"], description: "local-hash 无需下载或密钥，仅提供词法相似度；需要语义检索时配置 OpenAI-compatible Embedding。" },
      { key: "memory.embedding.model", label: "Embedding 模型", type: "text" },
      { key: "memory.embedding.dimensions", label: "Embedding 维度", type: "number" },
      { key: "memory.embedding.apiUrl", label: "Embedding API URL", type: "text" },
      { key: "memory.embedding.apiKey", label: "Embedding API Key", type: "password" },
      { key: "memory.maxItemChars", label: "单条记忆字符上限", type: "number" },
      { key: "memory.maxTotalChars", label: "全部记忆字符上限", type: "number" },
      { key: "memory.retrieval.maxResults", label: "自动召回条数", type: "number" },
      { key: "memory.retrieval.maxContextChars", label: "召回上下文字符上限", type: "number" },
      { key: "memory.retrieval.minScore", label: "最低召回分数", type: "number" },
      { key: "memory.maintenance.inactiveTurns", label: "未使用轮次阈值", type: "number" },
      { key: "memory.maintenance.inactiveDays", label: "未使用天数阈值", type: "number" },
      { key: "memory.maintenance.trashRetentionDays", label: "回收站保留天数", type: "number" },
    ],
  },
  {
    title: "搜索",
    fields: [
      { key: "searchProvider", label: "搜索引擎", type: "select", options: ["ollama", "duckduckgo", "searxng", "brave"] },
      { key: "ollamaApiKey", label: "Ollama API Key", type: "password" },
      { key: "searxngUrl", label: "SearXNG URL", type: "text" },
      { key: "braveApiKey", label: "Brave API Key", type: "password" },
    ],
  },
  {
    title: "图片附件",
    fields: [
      { key: "attachments.enabled", label: "允许上传图片", type: "checkbox" },
      { key: "attachments.maxFilesPerMessage", label: "每条消息图片上限", type: "number" },
      { key: "attachments.maxFileSize", label: "单张图片字节上限", type: "number" },
      { key: "attachments.allowedImageTypes", label: "允许的图片类型", type: "list" },
    ],
  },
  {
    title: "权限与 Gateway",
    fields: [
      { key: "security.tools", label: "工具权限覆盖", type: "json", description: "按工具名设置 mode，可覆盖全局配置。" },
      { key: "security.background.timeoutSeconds", label: "后台任务超时（秒）", type: "number" },
      { key: "security.background.maxRunning", label: "后台任务并发上限", type: "number" },
      { key: "security.background.maxLogChars", label: "后台任务日志字符上限", type: "number" },
      { key: "security.gateway.host", label: "Gateway Host", type: "text" },
      { key: "security.gateway.token", label: "Gateway Token", type: "password" },
      { key: "security.gateway.sseHeartbeatIntervalMs", label: "SSE 心跳间隔（毫秒）", type: "number" },
      { key: "security.auditTools", label: "记录工具审计日志", type: "checkbox" },
    ],
  },
  {
    title: "项目开发模式",
    fields: [
      { key: "project.security.tools", label: "项目工具权限覆盖", type: "json" },
      { key: "project.maxAgentIterations", label: "项目最大 Agent 迭代", type: "number" },
      { key: "project.gitTimeoutMs", label: "Git 操作超时（毫秒）", type: "number" },
      { key: "project.diffMaxChars", label: "Diff 最大字符数", type: "number" },
      { key: "project.openTimeoutMs", label: "打开项目超时（毫秒）", type: "number" },
      { key: "project.treeMaxDepth", label: "目录树最大深度", type: "number" },
      { key: "project.treeMaxEntries", label: "目录树最大条目数", type: "number" },
      { key: "project.searchMaxResults", label: "项目搜索最大结果数", type: "number" },
      { key: "project.searchMaxChars", label: "项目搜索最大字符数", type: "number" },
      { key: "project.searchTimeoutMs", label: "项目搜索超时（毫秒）", type: "number" },
    ],
  },
  {
    title: "Sub-agent",
    fields: [
      { key: "subAgent.allowedTools", label: "允许工具", type: "list" },
      { key: "subAgent.disabledTools", label: "禁用工具", type: "list" },
      { key: "subAgent.maxIterations", label: "最大迭代次数", type: "number" },
      { key: "subAgent.maxConcurrency", label: "最大并发数", type: "number" },
    ],
  },
  {
    title: "任务计划",
    fields: [
      { key: "plan.enabled", label: "显示任务计划", type: "checkbox" },
      { key: "plan.maxSteps", label: "最大计划步骤数", type: "number" },
    ],
  },
  {
    title: "插件",
    fields: [
      { key: "enabledPlugins", label: "启用的内置插件", type: "list", description: "每行填写一个插件名，如 feishu。" },
      { key: "externalPlugins", label: "外部插件入口", type: "list" },
      { key: "plugins", label: "插件私有配置", type: "json", description: "按插件名组织的 JSON 配置；密钥会自动脱敏。" },
    ],
  },
  {
    title: "调试",
    fields: [
      { key: "debug.enabled", label: "启用 Debug", type: "checkbox" },
      { key: "debug.modelIO", label: "记录模型输入输出", type: "checkbox" },
      { key: "debug.rawStreamEvents", label: "记录原始流事件", type: "checkbox" },
    ],
  },
];

const DRAFT_FIELDS = FIELD_GROUPS.flatMap((group) => group.fields)
  .filter((field) => field.type === "list" || field.type === "json");

function buildDrafts(config: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(DRAFT_FIELDS.map((field) => [
    field.key,
    formatDraft(getValue(config, field.key) ?? getValue(defaults, field.key), field.type),
  ]));
}

export default function ConfigEditor() {
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedDrafts, setSavedDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [localModels, setLocalModels] = useState<LocalModelStatus[]>([]);
  const [localModelsLoading, setLocalModelsLoading] = useState(true);
  const [localModelsError, setLocalModelsError] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [modelMessages, setModelMessages] = useState<Partial<Record<string, { text: string; error: boolean }>>>({});

  const refreshLocalModels = useCallback(async (showLoading = false) => {
    if (showLoading) setLocalModelsLoading(true);
    try {
      setLocalModels(await fetchLocalModels());
      setLocalModelsError("");
    } catch (error) {
      setLocalModelsError(error instanceof Error ? error.message : "无法读取本地模型状态");
    } finally {
      setLocalModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLocalModels();
    const timer = window.setInterval(() => void refreshLocalModels(), 1500);
    return () => window.clearInterval(timer);
  }, [refreshLocalModels]);

  useEffect(() => {
    fetchConfigSettings()
      .then(({ config: value, defaults }) => {
        setDefaults(defaults);
        const normalized = normalizeConfig(value);
        const nextDrafts = buildDrafts(normalized, defaults);
        setConfig(normalized);
        setEdited(normalized);
        setDrafts(nextDrafts);
        setSavedDrafts(nextDrafts);
      })
      .catch((error) => {
        setIsError(true);
        setMessage(error instanceof Error ? error.message : "加载配置失败");
      })
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (key: string, value: unknown) => {
    setEdited((previous) => setValue(previous, key, value));
  };

  const handleRemoteProfilesChange = (nextRemote: ModelProfile[]) => {
    setEdited((previous) => {
      const prevModels = readProfiles(getValue(previous, "models"));
      const local = prevModels.find((profile) => profile.provider === "local-llama");
      const nextModels = local ? [...nextRemote, local] : nextRemote;
      let next = setValue(previous, "models", nextModels);
      const currentDefault = typeof getValue(next, "defaultModelId") === "string" ? String(getValue(next, "defaultModelId")) : "";
      if (currentDefault && !nextModels.some((profile) => profile.id === currentDefault)) {
        next = setValue(next, "defaultModelId", undefined);
      }
      return next;
    });
  };

  const handleLocalEnabledChange = (enabled: boolean) => {
    setEdited((previous) => {
      const prevModels = readProfiles(getValue(previous, "models"));
      const remote = prevModels.filter((profile) => profile.provider !== "local-llama");
      let nextModels: ModelProfile[];
      if (enabled) {
        const existing = prevModels.find((profile) => profile.provider === "local-llama");
        const local: ModelProfile = existing ?? {
          id: "local",
          name: "本地模型",
          provider: "local-llama",
          localModelId: localModels.find((model) => model.installed)?.id ?? localModels[0]?.id ?? "",
        };
        nextModels = [...remote, local];
      } else {
        nextModels = remote;
      }
      let next = setValue(previous, "models", nextModels);
      const currentDefault = typeof getValue(next, "defaultModelId") === "string" ? String(getValue(next, "defaultModelId")) : "";
      if (!enabled && currentDefault === "local") {
        next = setValue(next, "defaultModelId", undefined);
      }
      return next;
    });
  };

  const handleLocalModelChange = (modelId: string) => {
    setEdited((previous) => {
      const prevModels = readProfiles(getValue(previous, "models"));
      const model = localModels.find((item) => item.id === modelId);
      const nextModels = prevModels.map((profile) => profile.provider === "local-llama"
        ? { ...profile, localModelId: modelId, contextSize: model ? model.recommendedContextTokens : profile.contextSize }
        : profile);
      return setValue(previous, "models", nextModels);
    });
  };

  const handleLocalContextSizeChange = (value: number) => {
    setEdited((previous) => {
      const prevModels = readProfiles(getValue(previous, "models"));
      const nextModels = prevModels.map((profile) => profile.provider === "local-llama"
        ? { ...profile, contextSize: value > 0 ? value : undefined }
        : profile);
      return setValue(previous, "models", nextModels);
    });
  };

  const handleDefaultModelChange = (modelId: string) => {
    setEdited((previous) => setValue(previous, "defaultModelId", modelId || undefined));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    setIsError(false);
    try {
      let next = edited;
      for (const field of DRAFT_FIELDS) {
        const draft = drafts[field.key] ?? "";
        if (draft === savedDrafts[field.key]) continue;
        if (field.type === "list") {
          next = setValue(next, field.key, parseList(draft));
          continue;
        }
        const parsed = JSON.parse(draft || "{}") as unknown;
        if (!isRecord(parsed)) throw new Error(`${field.label} 必须是 JSON 对象`);
        next = setValue(next, field.key, parsed);
      }

      const updated = normalizeConfig(await updateConfig(next));
      const nextDrafts = buildDrafts(updated, defaults);
      setConfig(updated);
      setEdited(updated);
      setDrafts(nextDrafts);
      setSavedDrafts(nextDrafts);
      setMessage("配置已保存。模型配置对新会话生效；插件启停等启动配置需要重启应用。");
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setEdited(config);
    setDrafts(savedDrafts);
    setMessage("");
    setIsError(false);
  };

  const handleTest = async (target: "remote" | "local", modelId?: string) => {
    const key = modelId ?? target;
    setTesting(key);
    setModelMessages((previous) => ({ ...previous, [key]: undefined }));
    try {
      const result = await testModel(target, edited, modelId);
      setModelMessages((previous) => ({ ...previous, [key]: { text: `测试成功（${result.elapsedMs}ms）：${result.text}`, error: false } }));
    } catch (error) {
      setModelMessages((previous) => ({ ...previous, [key]: { text: error instanceof Error ? error.message : "模型测试失败", error: true } }));
    } finally {
      setTesting(null);
    }
  };

  const handleDownload = async (modelId: string) => {
    setModelMessages((previous) => ({ ...previous, local: undefined }));
    setLocalModels((previous) => previous.map((model) => model.id === modelId
      ? { ...model, status: "downloading", progress: 0, downloadedBytes: 0, totalBytes: 0 }
      : model));
    try { await downloadLocalModel(modelId); }
    catch (error) {
      setModelMessages((previous) => ({ ...previous, local: { text: error instanceof Error ? error.message : "下载启动失败", error: true } }));
    }
  };

  if (loading) return <div className="empty-state">加载中...</div>;

  const hasChanges = JSON.stringify(edited) !== JSON.stringify(config)
    || JSON.stringify(drafts) !== JSON.stringify(savedDrafts);
  const profiles = readProfiles(getValue(edited, "models"));
  const remoteProfiles = profiles.filter((profile) => profile.provider !== "local-llama");
  const localProfile = profiles.find((profile) => profile.provider === "local-llama");
  const remoteEnabled = remoteProfiles.length > 0;
  const localEnabled = Boolean(localProfile);
  const selectedModelId = localProfile?.localModelId ?? "";
  const selectedLocalModel = localModels.find((model) => model.id === selectedModelId);
  const defaultModelId = typeof getValue(edited, "defaultModelId") === "string"
    ? String(getValue(edited, "defaultModelId"))
    : "";

  const renderField = (field: FieldDef) => {
    const value = getValue(edited, field.key) ?? getValue(defaults, field.key);
    const id = `config-${field.key}`;
    return (
      <div key={field.key} className={`config-field ${field.type === "json" || field.type === "list" ? "config-field-multiline" : ""}`}>
        <label htmlFor={id}>{field.label}{field.required ? " *" : ""}{field.description && <small>{field.description}</small>}</label>
        {field.type === "select" && <select id={id} value={String(value ?? "")} onChange={(event) => handleChange(field.key, event.target.value)}>{field.options?.map((option) => <option key={option} value={option}>{field.optionLabels?.[option] ?? option}</option>)}</select>}
        {field.type === "number" && <input id={id} type="number" value={Number(value ?? 0)} onChange={(event) => handleChange(field.key, Number(event.target.value))} />}
        {field.type === "percent" && <input id={id} type="number" min={0} max={100} step="any" value={Number((Number(value ?? 0) * 100).toFixed(8))} onChange={(event) => handleChange(field.key, Number(event.target.value) / 100)} />}
        {field.type === "checkbox" && <input id={id} className="config-checkbox" type="checkbox" checked={Boolean(value)} onChange={(event) => handleChange(field.key, event.target.checked)} />}
        {(field.type === "text" || field.type === "password") && <input id={id} type={field.type} value={String(value ?? "")} autoComplete={field.type === "password" ? "new-password" : undefined} onChange={(event) => handleChange(field.key, event.target.value)} />}
        {(field.type === "list" || field.type === "json") && <textarea id={id} rows={field.type === "json" ? 7 : 4} value={drafts[field.key] ?? ""} spellCheck={false} onChange={(event) => setDrafts((previous) => ({ ...previous, [field.key]: event.target.value }))} />}
      </div>
    );
  };

  return (
    <div className="config-editor">
      <div className="config-intro">
        所有运行配置都保存在当前 workspace 的 config.json。远程和本地模型可独立启用，同时启用时优先使用远程模型。
      </div>
      {remoteEnabled && localEnabled && <div className="model-priority-note">当前同时启用了远程与本地模型，聊天将优先使用默认模型。</div>}
      <div className="model-card-grid">
        <section className="config-group model-config-card">
          <div className="model-card-heading">
            <div><h3>远程模型</h3><p>配置一个或多个远程模型，可在聊天中切换。</p></div>
          </div>
          <ModelProfilesEditor
            profiles={remoteProfiles}
            onChange={handleRemoteProfilesChange}
            testingId={testing}
            messages={modelMessages}
            onTest={(profile) => void handleTest("remote", profile.id)}
          />
        </section>
        <section className="config-group model-config-card">
          <div className="model-card-heading">
            <div><h3>本地模型</h3><p>模型在本机运行，不需要 API Key。</p></div>
            <label className="model-enable-switch">
              <span>{localEnabled ? "已启用" : "未启用"}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label="启用本地模型"
                checked={localEnabled}
                onChange={(event) => handleLocalEnabledChange(event.target.checked)}
              />
              <span className="model-switch-track" aria-hidden="true"><span /></span>
            </label>
          </div>
          {localEnabled && (
            <>
              <div className="config-field">
                <label htmlFor="config-local-model">本地模型</label>
                <select id="config-local-model" value={selectedModelId} onChange={(event) => handleLocalModelChange(event.target.value)}>
                  {localModels.length === 0 && <option value="">{localModelsLoading ? "正在读取模型目录..." : ""}</option>}
                  {(["Qwen", "Gemma"] as const).map((family) => (
                    <optgroup key={family} label={family === "Qwen" ? "Qwen3.5" : "Gemma 4"}>
                      {localModels.filter((model) => model.family === family).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="config-field">
                <label htmlFor="config-local-context">本地上下文 Token</label>
                <input id="config-local-context" type="number" value={Number(localProfile?.contextSize ?? 0)} onChange={(event) => handleLocalContextSizeChange(Number(event.target.value))} />
              </div>
              <div className="selected-model-status">
                {localModelsError ? (
                  <div className="model-status-error">
                    <strong>模型状态加载失败</strong>
                    <small>{localModelsError}</small>
                    <button type="button" onClick={() => void refreshLocalModels(true)}>重新加载</button>
                  </div>
                ) : (
                  <div className="selected-model-summary"><div><strong>{selectedLocalModel?.name ?? (localModelsLoading ? "正在读取模型状态..." : "未找到所选模型")}</strong><small>{selectedLocalModel ? `${selectedLocalModel.family} · ${selectedLocalModel.size} · ${selectedLocalModel.license}` : ""}</small>{selectedLocalModel && <small>{selectedLocalModel.description}</small>}{selectedLocalModel && <small>建议至少 {selectedLocalModel.recommendedMemoryGb} GB 内存；推荐上下文 {selectedLocalModel.recommendedContextTokens.toLocaleString()}，模型上限 {selectedLocalModel.maxContextTokens.toLocaleString()} tokens</small>}</div></div>
                )}
                {!localModelsError && selectedLocalModel?.status === "downloading" ? (
                  <div className="model-download-progress">
                    <div className="download-progress-label"><span>正在下载</span><strong>{Math.round(selectedLocalModel.progress * 100)}%</strong></div>
                    <progress max={1} value={selectedLocalModel.progress} aria-label="模型下载进度" />
                    <small>{formatBytes(selectedLocalModel.downloadedBytes)} / {selectedLocalModel.totalBytes > 0 ? formatBytes(selectedLocalModel.totalBytes) : "计算中"}</small>
                  </div>
                ) : !localModelsError && selectedLocalModel?.installed ? (
                  <div className="model-installed-state">已安装，可以使用和测试。</div>
                ) : !localModelsError && !localModelsLoading ? (
                  <div className="model-not-installed">选择模型不会自动下载。点击“下载并安装”后才会开始下载。</div>
                ) : null}
                {!localModelsError && selectedLocalModel && !selectedLocalModel.installed && selectedLocalModel.status !== "downloading" && <div className="model-warning">当前启用的本地模型尚未安装，下载完成前无法使用。</div>}
                {selectedLocalModel?.error && <div className="config-message error">下载失败：{selectedLocalModel.error}</div>}
              </div>
              <div className="model-card-actions">
                {selectedLocalModel?.installed ? (
                  <button type="button" onClick={() => void handleTest("local")} disabled={testing !== null}>{testing === "local" ? "测试中..." : "测试模型"}</button>
                ) : (
                  <button type="button" className="primary" onClick={() => void handleDownload(selectedModelId)} disabled={!selectedLocalModel || selectedLocalModel.status === "downloading"}>{selectedLocalModel?.status === "downloading" ? "正在下载..." : selectedLocalModel?.status === "error" ? "重新下载" : "下载并安装"}</button>
                )}
                {modelMessages.local && selectedLocalModel?.status !== "downloading" && <span className={`config-message ${modelMessages.local.error ? "error" : ""}`}>{modelMessages.local.text}</span>}
              </div>
            </>
          )}
        </section>
      </div>
      <section className="config-group">
        <h3>默认模型</h3>
        <p className="config-group-description">新会话默认使用的模型；聊天中可随时切换。</p>
        <div className="config-field">
          <label htmlFor="config-default-model">默认模型</label>
          <select id="config-default-model" value={defaultModelId} onChange={(event) => handleDefaultModelChange(event.target.value)}>
            <option value="">第一个模型</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name ?? profile.id}</option>)}
          </select>
        </div>
      </section>
      {FIELD_GROUPS.map((group) => (
        <section key={group.title} className="config-group">
          <h3>{group.title}</h3>
          {group.fields.map(renderField)}
        </section>
      ))}
      <div className="config-actions">
        <button onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? "保存中..." : "保存"}
        </button>
        <button onClick={handleReset} disabled={!hasChanges}>重置</button>
        {message && <span className={`config-message ${isError ? "error" : ""}`}>{message}</span>}
      </div>
    </div>
  );
}
