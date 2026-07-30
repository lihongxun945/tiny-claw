import { useEffect, useState, useRef } from "react";
import type { Session } from "../types.js";
import { fetchHistorySessions, deleteSession } from "../lib/api.js";

type View = "chat" | "memory" | "logs" | "config";

interface Props {
  activeSessionId: string | null;
  currentView: View;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onSessionDeleted: (id: string) => void;
  onViewChange: (view: View) => void;
  refreshKey: number;
}

export default function SessionSidebar({ activeSessionId, currentView, onSelectSession, onNewChat, onSessionDeleted, onViewChange, refreshKey }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const loadingRef = useRef(false);

  const loadSessions = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    try {
      const list = await fetchHistorySessions();
      setSessions(list.sort((a, b) => b.lastActivity - a.lastActivity));
    } catch {
      // ignore
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (refreshKey > 0) loadSessions();
  }, [refreshKey]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      onSessionDeleted(id);
    } catch {
      // ignore
    }
  };

  const formatId = (id: string) => {
    if (id.startsWith("feishu:")) return "飞书 " + id.slice(7).slice(0, 6);
    return id.slice(0, 8);
  };

  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diff = now.getTime() - ts;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}时前`;
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">t</span>
          <span>tiny-claw</span>
        </div>
        <button className="refresh-btn" onClick={loadSessions} disabled={isLoading} title="刷新会话列表">
          {isLoading ? "…" : "↻"}
        </button>
      </div>
      <div className="sidebar-primary-action">
        <button onClick={onNewChat}><span aria-hidden="true">＋</span> 新对话</button>
      </div>
      <div className="session-section-label">最近对话</div>
      <div className="session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeSessionId && currentView === "chat" ? "active" : ""}`}
            onClick={() => { onViewChange("chat"); onSelectSession(s.id); }}
          >
            <div className="session-info">
              <div className="session-id">{formatId(s.id)}</div>
              {s.preview && <div className="session-preview">{s.preview}</div>}
              <div className="session-time">{formatTime(s.lastActivity)}</div>
            </div>
            <button className="delete-btn" onClick={(e) => handleDelete(s.id, e)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="sidebar-nav">
        <button
          className={`nav-btn ${currentView === "chat" ? "active" : ""}`}
          onClick={() => onViewChange("chat")}
        ><span aria-hidden="true">◫</span>对话</button>
        <button
          className={`nav-btn ${currentView === "memory" ? "active" : ""}`}
          onClick={() => onViewChange("memory")}
        ><span aria-hidden="true">◇</span>记忆</button>
        <button
          className={`nav-btn ${currentView === "logs" ? "active" : ""}`}
          onClick={() => onViewChange("logs")}
        ><span aria-hidden="true">▤</span>日志</button>
        <button
          className={`nav-btn ${currentView === "config" ? "active" : ""}`}
          onClick={() => onViewChange("config")}
          aria-label="配置"
        ><span aria-hidden="true">⚙</span>设置</button>
      </div>
    </div>
  );
}
