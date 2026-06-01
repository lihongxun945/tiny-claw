import { useEffect, useState } from "react";
import { fetchConfig, updateConfig } from "../lib/api.js";

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "readonly";
  options?: string[];
}

const FIELD_GROUPS: Array<{ title: string; fields: FieldDef[] }> = [
  {
    title: "核心",
    fields: [
      { key: "apiUrl", label: "API URL", type: "text" },
      { key: "apiKey", label: "API Key", type: "readonly" },
      { key: "model", label: "模型", type: "text" },
    ],
  },
  {
    title: "模型参数",
    fields: [
      { key: "maxTokens", label: "Max Tokens", type: "number" },
      { key: "maxContextTokens", label: "Max Context Tokens", type: "number" },
      { key: "contextCompressionThreshold", label: "压缩阈值", type: "number" },
      { key: "historyWindowSize", label: "历史窗口", type: "number" },
      { key: "maxAgentIterations", label: "最大迭代 (0=不限)", type: "number" },
    ],
  },
  {
    title: "搜索",
    fields: [
      { key: "searchProvider", label: "搜索引擎", type: "select", options: ["ollama", "duckduckgo", "searxng", "brave"] },
      { key: "ollamaApiKey", label: "Ollama API Key", type: "text" },
      { key: "searxngUrl", label: "SearXNG URL", type: "text" },
      { key: "braveApiKey", label: "Brave API Key", type: "text" },
    ],
  },
  {
    title: "插件",
    fields: [
      { key: "enabledPlugins", label: "启用插件", type: "readonly" },
    ],
  },
];

export default function ConfigEditor() {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetchConfig()
      .then((c) => { setConfig(c); setEdited(c); })
      .catch(() => setMessage("加载配置失败"))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (key: string, value: unknown) => {
    setEdited((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    try {
      const updated = await updateConfig(edited);
      setConfig(updated);
      setEdited(updated);
      setMessage("配置已保存");
    } catch {
      setMessage("保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setEdited(config);
    setMessage("");
  };

  if (loading) return <div className="empty-state">加载中...</div>;

  const hasChanges = JSON.stringify(edited) !== JSON.stringify(config);

  return (
    <div className="config-editor">
      {FIELD_GROUPS.map((group) => (
        <div key={group.title} className="config-group">
          <h3>{group.title}</h3>
          {group.fields.map((field) => {
            const val = edited[field.key];
            const displayVal = Array.isArray(val) ? val.join(", ") : String(val ?? "");
            if (field.type === "readonly") {
              return (
                <div key={field.key} className="config-field">
                  <label>{field.label}</label>
                  <input type="text" value={displayVal} disabled />
                </div>
              );
            }
            if (field.type === "select") {
              return (
                <div key={field.key} className="config-field">
                  <label>{field.label}</label>
                  <select value={String(val ?? "")} onChange={(e) => handleChange(field.key, e.target.value)}>
                    {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              );
            }
            if (field.type === "number") {
              return (
                <div key={field.key} className="config-field">
                  <label>{field.label}</label>
                  <input
                    type="number"
                    value={val as number ?? 0}
                    onChange={(e) => handleChange(field.key, Number(e.target.value))}
                  />
                </div>
              );
            }
            return (
              <div key={field.key} className="config-field">
                <label>{field.label}</label>
                <input
                  type="text"
                  value={val as string ?? ""}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                />
              </div>
            );
          })}
        </div>
      ))}
      <div className="config-actions">
        <button onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? "保存中..." : "保存"}
        </button>
        <button onClick={handleReset} disabled={!hasChanges}>重置</button>
        {message && <span className="config-message">{message}</span>}
      </div>
    </div>
  );
}
