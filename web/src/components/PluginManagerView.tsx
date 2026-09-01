import { useEffect, useMemo, useState } from "react";
import { fetchPluginConfig, fetchPlugins, updatePluginConfig, updatePluginState } from "../lib/api.js";
import type { PluginConfigField, PluginConfigView, PluginSnapshot } from "../types.js";

const KIND_LABELS: Record<PluginSnapshot["kind"], string> = {
  core: "核心",
  builtin: "内置",
  workspace: "Workspace",
  external: "外部",
};

const STATE_LABELS: Record<PluginSnapshot["state"], string> = {
  registered: "已注册",
  starting: "启动中",
  active: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  failed: "失败",
  blocked: "已阻塞",
};

export default function PluginManagerView() {
  const [plugins, setPlugins] = useState<PluginSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [configView, setConfigView] = useState<PluginConfigView | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const selected = useMemo(() => plugins.find((plugin) => plugin.id === selectedId), [plugins, selectedId]);

  useEffect(() => {
    fetchPlugins()
      .then((items) => {
        setPlugins(items);
        setSelectedId((current) => current || items[0]?.id || "");
      })
      .catch((error) => setMessage({ text: error instanceof Error ? error.message : "插件列表加载失败", error: true }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setMessage(null);
    fetchPluginConfig(selectedId)
      .then((view) => {
        setConfigView(view);
        setDraft({ ...view.config });
        setJsonDrafts(Object.fromEntries(Object.entries(view.schema?.fields ?? {})
          .filter(([, field]) => field.type === "json")
          .map(([key]) => [key, JSON.stringify(view.config[key] ?? {}, null, 2)])));
      })
      .catch((error) => setMessage({ text: error instanceof Error ? error.message : "插件配置加载失败", error: true }));
  }, [selectedId]);

  const save = async () => {
    if (!configView?.schema) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = { ...draft };
      for (const [key, field] of Object.entries(configView.schema.fields)) {
        if (field.type === "json") next[key] = JSON.parse(jsonDrafts[key] || "{}");
      }
      const updated = await updatePluginConfig(selectedId, next);
      setConfigView(updated);
      setDraft({ ...updated.config });
      if (updated.plugin) setPlugins((items) => items.map((item) => item.id === updated.plugin!.id ? updated.plugin! : item));
      setMessage({ text: "插件配置已保存并完成重载。", error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "插件配置保存失败", error: true });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    if (!selected?.canToggle) return;
    const previous = selected;
    const nextEnabled = !selected.enabled;
    setToggling(true);
    setMessage(null);
    setPlugins((items) => items.map((item) => item.id === previous.id ? { ...item, enabled: nextEnabled } : item));
    try {
      const updated = await updatePluginState(previous.id, nextEnabled);
      setPlugins((items) => items.map((item) => item.id === updated.id ? updated : item));
      setMessage({ text: updated.enabled ? "插件已启用。" : "插件已禁用。", error: false });
    } catch (error) {
      setPlugins((items) => items.map((item) => item.id === previous.id ? previous : item));
      setMessage({ text: error instanceof Error ? error.message : "插件状态更新失败", error: true });
    } finally {
      setToggling(false);
    }
  };

  if (loading) return <div className="empty-state">正在加载插件...</div>;

  return (
    <div className="plugin-manager-view">
      <header className="plugin-manager-header">
        <div><h2>插件</h2><p>查看插件状态、私有配置、依赖和权限声明。</p></div>
        <button type="button" onClick={() => void fetchPlugins().then(setPlugins)}>刷新</button>
      </header>
      <div className="plugin-manager-layout">
        <nav className="plugin-list" aria-label="插件列表">
          {plugins.map((plugin) => <button key={plugin.id} className={plugin.id === selectedId ? "active" : ""} onClick={() => setSelectedId(plugin.id)}>
            <span><strong>{plugin.id}</strong><small>{KIND_LABELS[plugin.kind]} · v{plugin.version}</small></span>
            <em className={`plugin-state plugin-state-${plugin.state}`}>{plugin.enabled ? STATE_LABELS[plugin.state] : "已禁用"}</em>
          </button>)}
        </nav>
        {selected && <main className="plugin-detail">
          <section className="plugin-detail-heading">
            <div><h3>{selected.id}</h3><p>{selected.description || `${KIND_LABELS[selected.kind]}插件`}</p></div>
            <div className="plugin-heading-actions">
              <span className={`plugin-state plugin-state-${selected.state}`}>{selected.enabled ? STATE_LABELS[selected.state] : "已禁用"}</span>
              <label className={`plugin-switch ${!selected.canToggle ? "locked" : ""}`}>
                <input aria-label="启用插件" type="checkbox" checked={selected.enabled} disabled={!selected.canToggle || toggling} onChange={() => void toggle()} />
                <span />
              </label>
            </div>
          </section>
          {selected.error && <div className="plugin-alert error">{selected.error}</div>}
          {selected.config.issues.map((issue) => <div key={`${issue.path}-${issue.code}`} className={`plugin-alert ${issue.severity}`}>{issue.message}</div>)}
          <section className="plugin-detail-section">
            <h4>配置</h4>
            {!configView?.schema ? <p className="plugin-empty-note">该插件没有声明可编辑配置。</p> : Object.entries(configView.schema.fields).map(([key, field]) => (
              <PluginField key={key} name={key} field={field} value={draft[key]} jsonDraft={jsonDrafts[key]} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} onJSONChange={(value) => setJsonDrafts((current) => ({ ...current, [key]: value }))} issue={configView.issues.find((item) => item.path === key)?.message} />
            ))}
            {configView?.schema && <button className="plugin-save-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存并重载中..." : "保存并重载"}</button>}
            {message && <div className={`plugin-message ${message.error ? "error" : ""}`}>{message.text}</div>}
          </section>
          <section className="plugin-detail-section">
            <h4>权限声明</h4>
            <p className="plugin-empty-note">权限声明表示插件可能使用的能力，不会绕过运行时审批。</p>
            <PermissionList plugin={selected} />
            {selected.permissions.issues.map((issue) => <div key={issue.capability} className={`plugin-alert ${issue.severity}`}>{issue.message}</div>)}
          </section>
          <section className="plugin-detail-section">
            <h4>依赖</h4>
            <DependencyList title="必需" values={selected.requires} />
            <DependencyList title="可选" values={selected.optional} />
          </section>
        </main>}
      </div>
    </div>
  );
}

function PluginField({ name, field, value, jsonDraft, onChange, onJSONChange, issue }: { name: string; field: PluginConfigField; value: unknown; jsonDraft?: string; onChange: (value: unknown) => void; onJSONChange: (value: string) => void; issue?: string }) {
  return <div className="plugin-config-field">
    <label htmlFor={`plugin-${name}`}>{field.title}{field.required ? " *" : ""}<small>{field.description}</small></label>
    {field.type === "boolean" && <input id={`plugin-${name}`} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />}
    {field.type === "number" && <input id={`plugin-${name}`} type="number" value={typeof value === "number" ? value : ""} min={field.min} max={field.max} step={field.integer ? 1 : "any"} onChange={(event) => onChange(Number(event.target.value))} />}
    {field.type === "select" && <select id={`plugin-${name}`} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
    {field.type === "string" && <input id={`plugin-${name}`} type={field.secret ? "password" : "text"} value={String(value ?? "")} autoComplete={field.secret ? "new-password" : undefined} onChange={(event) => onChange(event.target.value)} />}
    {field.type === "json" && <textarea id={`plugin-${name}`} rows={6} value={jsonDraft ?? ""} spellCheck={false} onChange={(event) => onJSONChange(event.target.value)} />}
    {issue && <span className="plugin-field-error">{issue}</span>}
  </div>;
}

function PermissionList({ plugin }: { plugin: PluginSnapshot }) {
  const permission = plugin.permissions.declared;
  const items = [
    permission.tools?.length ? `工具：${permission.tools.join("、")}` : "",
    permission.filesystem?.read?.length ? `文件读取：${permission.filesystem.read.join("、")}` : "",
    permission.filesystem?.write?.length ? `文件写入：${permission.filesystem.write.join("、")}` : "",
    permission.network?.hosts.length ? `网络：${permission.network.hosts.join("、")}` : "",
    permission.shell ? "Shell：需要" : "",
    permission.gatewayRoutes ? "Gateway 路由：需要" : "",
  ].filter(Boolean);
  return items.length ? <ul className="plugin-property-list">{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="plugin-empty-note">未声明权限。</p>;
}

function DependencyList({ title, values }: { title: string; values: Record<string, string> }) {
  const entries = Object.entries(values);
  return <div className="plugin-dependencies"><strong>{title}</strong>{entries.length ? entries.map(([id, range]) => <code key={id}>{id} {range}</code>) : <span>无</span>}</div>;
}
