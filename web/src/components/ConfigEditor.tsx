import { useCallback, useEffect, useState } from "react";
import { downloadLocalModel, fetchConfig, fetchLocalModels, testModel, updateConfig, type LocalModelStatus } from "../lib/api.js";

type FieldType = "text" | "password" | "number" | "select" | "checkbox" | "list" | "json";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  optionLabels?: Record<string, string>;
  defaultValue?: unknown;
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gigabytes = bytes / (1024 ** 3);
  if (gigabytes >= 1) return `${gigabytes.toFixed(2)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

const REMOTE_MODEL_FIELDS: FieldDef[] = [
  { key: "apiUrl", label: "API URL", type: "text", required: true },
  { key: "apiKey", label: "API Key", type: "password", description: "仅远程模型需要；后端只返回脱敏值。" },
  { key: "model", label: "模型", type: "text", required: true },
  { key: "modelProvider", label: "模型协议", type: "select", options: ["anthropic-messages", "openai-chat", "chatgpt"], defaultValue: "anthropic-messages" },
];

const LOCAL_MODEL_FIELDS: FieldDef[] = [
  {
    key: "localModel.modelId",
    label: "本地模型",
    type: "select",
    defaultValue: "qwen3.5-4b-q4",
  },
  { key: "localModel.contextSize", label: "本地上下文 Token", type: "number", defaultValue: 32768 },
];

const FIELD_GROUPS: FieldGroup[] = [
  {
    title: "上下文与执行",
    fields: [
      { key: "maxTokens", label: "单次回复 Token", type: "number", defaultValue: 4096 },
      { key: "maxContextTokens", label: "上下文 Token 上限", type: "number", defaultValue: 128000 },
      { key: "contextCompressionThreshold", label: "上下文压缩阈值", type: "number", defaultValue: 0.7 },
      { key: "contextCompressionMaxChars", label: "压缩摘要字符上限", type: "number", defaultValue: 5000 },
      { key: "contextCompressionToolResultMaxChars", label: "压缩工具结果字符上限", type: "number", defaultValue: 500 },
      { key: "toolResultInitialMaxChars", label: "工具结果初始字符上限", type: "number", defaultValue: 12000 },
      { key: "historyWindowSize", label: "历史窗口轮数", type: "number", defaultValue: 5 },
      { key: "maxAgentIterations", label: "最大 Agent 迭代", type: "number", defaultValue: 20, description: "设置为 0 表示不限制。" },
    ],
  },
  {
    title: "会话摘要",
    fields: [
      { key: "sessionSummary.enabled", label: "启用", type: "checkbox", defaultValue: true },
      { key: "sessionSummary.persistent", label: "持久化", type: "checkbox", defaultValue: true },
      { key: "sessionSummary.turnThreshold", label: "整理轮数阈值", type: "number", defaultValue: 5 },
      { key: "sessionSummary.recentTurns", label: "保留近期原文轮数", type: "number", defaultValue: 3 },
      { key: "sessionSummary.maxChars", label: "摘要字符上限", type: "number", defaultValue: 4000 },
    ],
  },
  {
    title: "自动记忆",
    fields: [
      { key: "autoMemory.enabled", label: "启用", type: "checkbox", defaultValue: true },
      { key: "autoMemory.mode", label: "整理模式", type: "select", options: ["auto", "hybrid", "suggest"], defaultValue: "hybrid" },
      { key: "autoMemory.turnThreshold", label: "整理轮数阈值", type: "number", defaultValue: 10 },
      { key: "autoMemory.maxCandidates", label: "最大工具调用次数", type: "number", defaultValue: 5 },
      { key: "autoMemory.maxBatchChars", label: "整理输入字符上限", type: "number", defaultValue: 8000 },
      { key: "autoMemory.lockTimeoutSeconds", label: "整理锁超时（秒）", type: "number", defaultValue: 300 },
      { key: "memory.maxItemChars", label: "单条记忆字符上限", type: "number", defaultValue: 20000 },
      { key: "memory.maxTotalChars", label: "全部记忆字符上限", type: "number", defaultValue: 80000 },
    ],
  },
  {
    title: "搜索",
    fields: [
      { key: "searchProvider", label: "搜索引擎", type: "select", options: ["ollama", "duckduckgo", "searxng", "brave"], defaultValue: "duckduckgo" },
      { key: "ollamaApiKey", label: "Ollama API Key", type: "password" },
      { key: "searxngUrl", label: "SearXNG URL", type: "text" },
      { key: "braveApiKey", label: "Brave API Key", type: "password" },
    ],
  },
  {
    title: "图片附件",
    fields: [
      { key: "attachments.enabled", label: "允许上传图片", type: "checkbox", defaultValue: true },
      { key: "attachments.maxFilesPerMessage", label: "每条消息图片上限", type: "number", defaultValue: 4 },
      { key: "attachments.maxFileSize", label: "单张图片字节上限", type: "number", defaultValue: 10485760 },
      { key: "attachments.allowedImageTypes", label: "允许的图片类型", type: "list", defaultValue: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
    ],
  },
  {
    title: "权限与 Gateway",
    fields: [
      { key: "security.mode", label: "全局危险操作模式", type: "select", options: ["deny", "ask", "allow"], defaultValue: "allow" },
      { key: "security.tools", label: "工具权限覆盖", type: "json", defaultValue: {}, description: "按工具名设置 mode，可覆盖全局模式。" },
      { key: "security.gateway.host", label: "Gateway Host", type: "text", defaultValue: "127.0.0.1" },
      { key: "security.gateway.token", label: "Gateway Token", type: "password" },
      { key: "security.gateway.sseHeartbeatIntervalMs", label: "SSE 心跳间隔（毫秒）", type: "number", defaultValue: 15000 },
      { key: "security.auditTools", label: "记录工具审计日志", type: "checkbox", defaultValue: true },
    ],
  },
  {
    title: "Sub-agent",
    fields: [
      { key: "subAgent.allowedTools", label: "允许工具", type: "list", defaultValue: [] },
      { key: "subAgent.disabledTools", label: "禁用工具", type: "list", defaultValue: [] },
      { key: "subAgent.maxIterations", label: "最大迭代次数", type: "number", defaultValue: 3 },
      { key: "subAgent.maxConcurrency", label: "最大并发数", type: "number", defaultValue: 3 },
    ],
  },
  {
    title: "插件",
    fields: [
      { key: "enabledPlugins", label: "启用的内置插件", type: "list", defaultValue: [], description: "每行填写一个插件名，如 feishu。" },
      { key: "externalPlugins", label: "外部插件入口", type: "list", defaultValue: [] },
      { key: "plugins", label: "插件私有配置", type: "json", defaultValue: {}, description: "按插件名组织的 JSON 配置；密钥会自动脱敏。" },
    ],
  },
  {
    title: "调试",
    fields: [
      { key: "debug.enabled", label: "启用 Debug", type: "checkbox", defaultValue: false },
      { key: "debug.modelIO", label: "记录模型输入输出", type: "checkbox", defaultValue: false },
      { key: "debug.rawStreamEvents", label: "记录原始流事件", type: "checkbox", defaultValue: false },
    ],
  },
];

const DRAFT_FIELDS = [...REMOTE_MODEL_FIELDS, ...LOCAL_MODEL_FIELDS, ...FIELD_GROUPS.flatMap((group) => group.fields)]
  .filter((field) => field.type === "list" || field.type === "json");

function buildDrafts(config: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(DRAFT_FIELDS.map((field) => [
    field.key,
    formatDraft(getValue(config, field.key) ?? field.defaultValue, field.type),
  ]));
}

export default function ConfigEditor() {
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
  const [testing, setTesting] = useState<"remote" | "local" | null>(null);
  const [modelMessages, setModelMessages] = useState<Partial<Record<"remote" | "local", { text: string; error: boolean }>>>({});

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
    fetchConfig()
      .then((value) => {
        const normalized = normalizeConfig(value);
        const nextDrafts = buildDrafts(normalized);
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
    setEdited((previous) => {
      const next = setValue(previous, key, value);
      if (key !== "localModel.modelId") return next;
      const model = localModels.find((item) => item.id === value);
      return model ? setValue(next, "localModel.contextSize", model.recommendedContextTokens) : next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    setIsError(false);
    try {
      let next = edited;
      for (const field of DRAFT_FIELDS) {
        const draft = drafts[field.key] ?? "";
        if (field.type === "list") {
          next = setValue(next, field.key, parseList(draft));
          continue;
        }
        const parsed = JSON.parse(draft || "{}") as unknown;
        if (!isRecord(parsed)) throw new Error(`${field.label} 必须是 JSON 对象`);
        next = setValue(next, field.key, parsed);
      }

      const updated = normalizeConfig(await updateConfig(next));
      const nextDrafts = buildDrafts(updated);
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

  const handleTest = async (target: "remote" | "local") => {
    setTesting(target);
    setModelMessages((previous) => ({ ...previous, [target]: undefined }));
    try {
      const result = await testModel(target, edited);
      setModelMessages((previous) => ({ ...previous, [target]: { text: `测试成功（${result.elapsedMs}ms）：${result.text}`, error: false } }));
    } catch (error) {
      setModelMessages((previous) => ({ ...previous, [target]: { text: error instanceof Error ? error.message : "模型测试失败", error: true } }));
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
  const selectedModelId = String(getValue(edited, "localModel.modelId") ?? "qwen3.5-4b-q4");
  const selectedLocalModel = localModels.find((model) => model.id === selectedModelId);
  const remoteEnabled = Boolean(getValue(edited, "remoteModel.enabled") ?? true);
  const localEnabled = Boolean(getValue(edited, "localModel.enabled") ?? false);

  const renderField = (field: FieldDef) => {
    const value = getValue(edited, field.key) ?? field.defaultValue;
    const id = `config-${field.key}`;
    return (
      <div key={field.key} className={`config-field ${field.type === "json" || field.type === "list" ? "config-field-multiline" : ""}`}>
        <label htmlFor={id}>{field.label}{field.required ? " *" : ""}{field.description && <small>{field.description}</small>}</label>
        {field.type === "select" && field.key === "localModel.modelId" && <select id={id} value={String(value ?? "")} onChange={(event) => handleChange(field.key, event.target.value)}>
          {localModels.length === 0 && <option value={String(value ?? "")}>{localModelsLoading ? "正在读取模型目录..." : String(value ?? "")}</option>}
          {(["Qwen", "Gemma"] as const).map((family) => <optgroup key={family} label={family === "Qwen" ? "Qwen3.5" : "Gemma 4"}>
            {localModels.filter((model) => model.family === family).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </optgroup>)}
        </select>}
        {field.type === "select" && field.key !== "localModel.modelId" && <select id={id} value={String(value ?? "")} onChange={(event) => handleChange(field.key, event.target.value)}>{field.options?.map((option) => <option key={option} value={option}>{field.optionLabels?.[option] ?? option}</option>)}</select>}
        {field.type === "number" && <input id={id} type="number" value={Number(value ?? 0)} onChange={(event) => handleChange(field.key, Number(event.target.value))} />}
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
      {remoteEnabled && localEnabled && <div className="model-priority-note">当前同时启用了两种模型，聊天将优先使用远程模型。</div>}
      <div className="model-card-grid">
        <section className="config-group model-config-card">
          <div className="model-card-heading">
            <div><h3>远程模型</h3><p>连接 OpenAI、Anthropic 或兼容服务。</p></div>
            <label className="model-enable-switch">
              <span>{remoteEnabled ? "已启用" : "未启用"}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label="启用远程模型"
                checked={remoteEnabled}
                onChange={(event) => handleChange("remoteModel.enabled", event.target.checked)}
              />
              <span className="model-switch-track" aria-hidden="true"><span /></span>
            </label>
          </div>
          {REMOTE_MODEL_FIELDS.map(renderField)}
          <div className="model-card-actions">
            <button type="button" onClick={() => void handleTest("remote")} disabled={testing !== null}>{testing === "remote" ? "测试中..." : "测试连接"}</button>
            {modelMessages.remote && <span className={`config-message ${modelMessages.remote.error ? "error" : ""}`}>{modelMessages.remote.text}</span>}
          </div>
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
                onChange={(event) => handleChange("localModel.enabled", event.target.checked)}
              />
              <span className="model-switch-track" aria-hidden="true"><span /></span>
            </label>
          </div>
          {LOCAL_MODEL_FIELDS.map(renderField)}
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
            {!localModelsError && localEnabled && selectedLocalModel && !selectedLocalModel.installed && selectedLocalModel.status !== "downloading" && <div className="model-warning">当前启用的本地模型尚未安装，下载完成前无法使用。</div>}
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
        </section>
      </div>
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
