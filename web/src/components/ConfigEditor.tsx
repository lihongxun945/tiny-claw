import { useEffect, useState } from "react";
import { fetchConfig, updateConfig } from "../lib/api.js";

type FieldType = "text" | "password" | "number" | "select" | "checkbox" | "list" | "json";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
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

const FIELD_GROUPS: FieldGroup[] = [
  {
    title: "模型",
    fields: [
      { key: "apiUrl", label: "API URL", type: "text", required: true },
      { key: "apiKey", label: "API Key", type: "password", required: true, description: "首次启动时为空；后端只返回脱敏值。" },
      { key: "model", label: "模型", type: "text", required: true },
      { key: "modelProvider", label: "模型协议", type: "select", options: ["anthropic-messages", "openai-chat", "chatgpt"], defaultValue: "anthropic-messages" },
    ],
  },
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

const DRAFT_FIELDS = FIELD_GROUPS.flatMap((group) => group.fields).filter((field) => field.type === "list" || field.type === "json");

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
    setEdited((previous) => setValue(previous, key, value));
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

  if (loading) return <div className="empty-state">加载中...</div>;

  const hasChanges = JSON.stringify(edited) !== JSON.stringify(config)
    || JSON.stringify(drafts) !== JSON.stringify(savedDrafts);

  return (
    <div className="config-editor">
      <div className="config-intro">
        所有运行配置都保存在当前 workspace 的 config.json。带 * 的字段必须设置；密钥留空时相关能力不可用。
      </div>
      {FIELD_GROUPS.map((group) => (
        <section key={group.title} className="config-group">
          <h3>{group.title}</h3>
          {group.fields.map((field) => {
            const value = getValue(edited, field.key) ?? field.defaultValue;
            const id = `config-${field.key}`;
            return (
              <div key={field.key} className={`config-field ${field.type === "json" || field.type === "list" ? "config-field-multiline" : ""}`}>
                <label htmlFor={id}>
                  {field.label}{field.required ? " *" : ""}
                  {field.description && <small>{field.description}</small>}
                </label>
                {field.type === "select" && (
                  <select id={id} value={String(value ?? "")} onChange={(event) => handleChange(field.key, event.target.value)}>
                    {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                )}
                {field.type === "number" && (
                  <input id={id} type="number" value={Number(value ?? 0)} onChange={(event) => handleChange(field.key, Number(event.target.value))} />
                )}
                {field.type === "checkbox" && (
                  <input id={id} className="config-checkbox" type="checkbox" checked={Boolean(value)} onChange={(event) => handleChange(field.key, event.target.checked)} />
                )}
                {(field.type === "text" || field.type === "password") && (
                  <input
                    id={id}
                    type={field.type}
                    value={String(value ?? "")}
                    autoComplete={field.type === "password" ? "new-password" : undefined}
                    onChange={(event) => handleChange(field.key, event.target.value)}
                  />
                )}
                {(field.type === "list" || field.type === "json") && (
                  <textarea
                    id={id}
                    rows={field.type === "json" ? 7 : 4}
                    value={drafts[field.key] ?? ""}
                    spellCheck={false}
                    onChange={(event) => setDrafts((previous) => ({ ...previous, [field.key]: event.target.value }))}
                  />
                )}
              </div>
            );
          })}
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
