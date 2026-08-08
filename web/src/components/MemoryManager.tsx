import { useEffect, useMemo, useState } from "react";
import type { MemoryRecord, MemorySource, ProfileRecord } from "../types.js";
import { deleteMemory, deleteProfile, fetchMemories, fetchMemory, fetchProfile, fetchProfiles, setMemoryEnabled, updateMemory, updateProfile } from "../lib/api.js";

const SOURCE_OPTIONS: MemorySource[] = ["auto", "tool", "manual"];

function emptyDraft(): MemoryRecord {
  const now = new Date().toISOString();
  return {
    name: "",
    summary: "",
    content: "",
    tags: [],
    scope: "global",
    disabled: false,
    source: "manual",
    createdAt: now,
    updatedAt: now,
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function parseTags(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function tagText(memory: MemoryRecord): string {
  return memory.tags.length > 0 ? memory.tags.join(", ") : "";
}

function ArchiveMemoryManager() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [draft, setDraft] = useState<MemoryRecord>(emptyDraft);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const loadMemories = async (nextSelectedName = selectedName) => {
    setLoading(true);
    setMessage("");
    try {
      const list = await fetchMemories();
      const sorted = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setMemories(sorted);
      const selected = sorted.find((item) => item.name === nextSelectedName) ?? sorted[0];
      if (selected) {
        setSelectedName(selected.name);
        setDraft(await fetchMemory(selected.name));
      } else {
        setSelectedName("");
        setDraft(emptyDraft());
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载记忆失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, []);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return memories;
    return memories.filter((memory) => [
      memory.name,
      memory.summary,
      memory.scope,
      memory.source,
      memory.tags.join(" "),
    ].join("\n").toLowerCase().includes(text));
  }, [memories, query]);

  const selected = memories.find((item) => item.name === selectedName);
  const hasChanges = selected ? JSON.stringify(draft) !== JSON.stringify(selected) : false;

  const handleSelect = async (name: string) => {
    setSelectedName(name);
    setMessage("");
    try {
      setDraft(await fetchMemory(name));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "读取记忆失败");
    }
  };

  const handleSave = async () => {
    if (!selectedName) return;
    setSaving(true);
    setMessage("");
    try {
      const updated = await updateMemory(selectedName, {
        content: draft.content,
        summary: draft.summary,
        tags: draft.tags,
        scope: draft.scope,
        disabled: draft.disabled,
        source: draft.source,
      });
      setMemories((prev) => prev.map((item) => item.name === updated.name ? updated : item).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setDraft(updated);
      setMessage("记忆已保存");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!selectedName) return;
    setSaving(true);
    setMessage("");
    try {
      const updated = await setMemoryEnabled(selectedName, draft.disabled);
      setDraft(updated);
      setMemories((prev) => prev.map((item) => item.name === updated.name ? updated : item));
      setMessage(updated.disabled ? "记忆已禁用" : "记忆已启用");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "状态更新失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedName) return;
    if (!confirm(`确定删除记忆 ${selectedName}？`)) return;
    setSaving(true);
    setMessage("");
    try {
      await deleteMemory(selectedName);
      await loadMemories("");
      setMessage("记忆已删除");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="memory-manager">
      <div className="memory-list-pane">
        <div className="memory-toolbar">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索记忆"
          />
          <button onClick={() => loadMemories()} disabled={loading}>刷新</button>
        </div>
        <div className="memory-list">
          {loading && <div className="empty-state">加载中...</div>}
          {!loading && message && memories.length === 0 && <div className="empty-state">{message}</div>}
          {!loading && !message && filtered.length === 0 && <div className="empty-state">暂无记忆</div>}
          {filtered.map((memory) => (
            <button
              key={memory.name}
              className={`memory-item ${memory.name === selectedName ? "active" : ""}`}
              onClick={() => handleSelect(memory.name)}
            >
              <span className="memory-item-title">
                <span>{memory.name}</span>
                <span className={`memory-state ${memory.disabled ? "disabled" : "enabled"}`}>
                  {memory.disabled ? "禁用" : "启用"}
                </span>
              </span>
              <span className="memory-summary">{memory.summary || "无摘要"}</span>
              <span className="memory-meta">
                {memory.source}
                {memory.scope ? ` · ${memory.scope}` : ""}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="memory-detail-pane">
        {!selectedName ? (
          <div className="empty-state">选择一条记忆查看详情</div>
        ) : (
          <>
            <div className="memory-detail-header">
              <div>
                <h2>{draft.name}</h2>
                <span>更新于 {formatTime(draft.updatedAt)}</span>
              </div>
              <div className="memory-actions">
                <button onClick={handleToggleEnabled} disabled={saving}>
                  {draft.disabled ? "启用" : "禁用"}
                </button>
                <button onClick={handleDelete} disabled={saving}>删除</button>
                <button onClick={handleSave} disabled={saving || !hasChanges}>
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div className="memory-form">
              <label>
                <span>摘要</span>
                <input
                  value={draft.summary}
                  onChange={(e) => setDraft((prev) => ({ ...prev, summary: e.target.value }))}
                />
              </label>
              <label>
                <span>标签</span>
                <input
                  value={tagText(draft)}
                  onChange={(e) => setDraft((prev) => ({ ...prev, tags: parseTags(e.target.value) }))}
                  placeholder="用英文逗号分隔"
                />
              </label>
              <div className="memory-form-row">
                <label>
                  <span>作用域</span>
                  <input
                    value={draft.scope}
                    onChange={(e) => setDraft((prev) => ({ ...prev, scope: e.target.value }))}
                  />
                </label>
                <label>
                  <span>来源</span>
                  <select
                    value={draft.source}
                    onChange={(e) => setDraft((prev) => ({ ...prev, source: e.target.value as MemorySource }))}
                  >
                    {SOURCE_OPTIONS.map((source) => <option key={source} value={source}>{source}</option>)}
                  </select>
                </label>
              </div>
              <div className="memory-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.disabled}
                    onChange={(e) => setDraft((prev) => ({ ...prev, disabled: e.target.checked }))}
                  />
                  禁用
                </label>
              </div>
              <label className="memory-content-field">
                <span>内容</span>
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft((prev) => ({ ...prev, content: e.target.value }))}
                />
              </label>
            </div>
            {message && <div className="memory-message">{message}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function ProfileManager() {
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [draft, setDraft] = useState<ProfileRecord | null>(null);
  const [message, setMessage] = useState("");

  const load = async (preferred = selectedName) => {
    try {
      const list = await fetchProfiles();
      setProfiles(list);
      const selected = list.find((item) => item.name === preferred) ?? list[0];
      setSelectedName(selected?.name ?? "");
      setDraft(selected ? await fetchProfile(selected.name) : null);
    } catch (error) { setMessage(error instanceof Error ? error.message : "加载 Profile 失败"); }
  };
  useEffect(() => { void load(); }, []);

  const select = async (name: string) => {
    setSelectedName(name);
    setDraft(await fetchProfile(name));
  };
  const save = async () => {
    if (!draft) return;
    try {
      const updated = await updateProfile(draft);
      setDraft(updated);
      await load(updated.name);
      setMessage("Profile 已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
  };
  const remove = async () => {
    if (!draft || !confirm(`确定删除 Profile ${draft.name}？`)) return;
    await deleteProfile(draft.name);
    setSelectedName("");
    await load("");
  };
  const create = () => {
    const now = new Date().toISOString();
    setSelectedName("");
    setDraft({ name: "", summary: "", content: "", disabled: false, source: "manual", createdAt: now, updatedAt: now });
  };

  return (
    <div className="memory-manager">
      <div className="memory-list-pane">
        <div className="memory-toolbar"><button onClick={create}>新建 Profile</button><button onClick={() => load()}>刷新</button></div>
        <div className="memory-list">
          {profiles.length === 0 && <div className="empty-state">暂无 Profile</div>}
          {profiles.map((profile) => <button key={profile.name} className={`memory-item ${profile.name === selectedName ? "active" : ""}`} onClick={() => select(profile.name)}><span className="memory-item-title"><span>{profile.name}</span><span className={`memory-state ${profile.disabled ? "disabled" : "enabled"}`}>{profile.disabled ? "禁用" : "固定注入"}</span></span><span className="memory-summary">{profile.summary || "无摘要"}</span></button>)}
        </div>
      </div>
      <div className="memory-detail-pane">
        {!draft ? <div className="empty-state">选择或新建一个 Profile</div> : <>
          <div className="memory-detail-header"><div><h2>{draft.name || "新 Profile"}</h2><span>每轮固定发送给模型</span></div><div className="memory-actions">{draft.name && <button onClick={remove}>删除</button>}<button onClick={save} disabled={!draft.name.trim() || !draft.content.trim()}>保存</button></div></div>
          <div className="memory-form">
            <label><span>名称</span><input value={draft.name} disabled={Boolean(selectedName)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="communication" /></label>
            <label><span>摘要</span><input value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
            <div className="memory-checks"><label><input type="checkbox" checked={draft.disabled} onChange={(event) => setDraft({ ...draft, disabled: event.target.checked })} />禁用</label></div>
            <label className="memory-content-field"><span>内容</span><textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
          </div>
          {message && <div className="memory-message">{message}</div>}
        </>}
      </div>
    </div>
  );
}

export default function MemoryManager() {
  const [tab, setTab] = useState<"profile" | "memory">("profile");
  return <div className="memory-view"><div className="memory-kind-tabs"><button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>用户 Profile</button><button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>长期记忆</button></div>{tab === "profile" ? <ProfileManager /> : <ArchiveMemoryManager />}</div>;
}
