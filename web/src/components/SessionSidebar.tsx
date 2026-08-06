import { useEffect, useState, useRef } from "react";
import type { Session } from "../types.js";
import { fetchHistorySessions, deleteSession } from "../lib/api.js";

type View = "chat" | "project" | "memory" | "logs" | "config";
type SidebarMode = "chat" | "project";

interface Props {
  activeSessionId: string | null;
  currentView: View;
  sidebarMode: SidebarMode;
  onSelectSession: (session: Session) => void;
  onNewChat: () => void;
  onNewProject: () => void;
  onNewProjectChat: (projectRoot: string) => void;
  onSessionDeleted: (id: string) => void;
  onProjectDeleted: (projectRoot: string, sessionIds: string[]) => void;
  onViewChange: (view: View) => void;
  refreshKey: number;
  projectRoot: string | null;
}

export default function SessionSidebar({ activeSessionId, currentView, sidebarMode, onSelectSession, onNewChat, onNewProject, onNewProjectChat, onSessionDeleted, onProjectDeleted, onViewChange, refreshKey, projectRoot }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingProjectRoot, setDeletingProjectRoot] = useState<string | null>(null);
  const loadRequestRef = useRef(0);

  const loadSessions = async () => {
    const requestId = ++loadRequestRef.current;
    setIsLoading(true);
    try {
      const list = await fetchHistorySessions();
      if (requestId === loadRequestRef.current) {
        setSessions(list.sort((a, b) => b.lastActivity - a.lastActivity));
      }
    } catch {
      // ignore
    } finally {
      if (requestId === loadRequestRef.current) setIsLoading(false);
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

  const handleDeleteProject = async (
    group: { root: string; name: string; sessions: Session[] },
    event: React.MouseEvent,
  ) => {
    event.stopPropagation();
    const confirmed = window.confirm(
      `确定删除项目“${group.name}”及其全部 ${group.sessions.length} 个会话吗？\n\n本地目录和文件不会被删除。`,
    );
    if (!confirmed) return;

    setDeletingProjectRoot(group.root);
    const sessionIds = group.sessions.map((session) => session.id);
    const results = await Promise.allSettled(sessionIds.map((id) => deleteSession(id)));
    const deletedIds = sessionIds.filter((_, index) => results[index].status === "fulfilled");
    setSessions((previous) => previous.filter((session) => !deletedIds.includes(session.id)));
    if (deletedIds.length > 0) onProjectDeleted(group.root, deletedIds);
    setDeletingProjectRoot(null);

    const failedCount = sessionIds.length - deletedIds.length;
    if (failedCount > 0) window.alert(`项目删除未完成，仍有 ${failedCount} 个会话删除失败，请重试。`);
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

  const projectGroups = Array.from(sessions.reduce((groups, session) => {
    if (session.context.mode !== "project" || !session.context.project) return groups;
    const { root, name } = session.context.project;
    const group = groups.get(root) ?? { root, name, sessions: [] as Session[], lastActivity: 0 };
    group.sessions.push(session);
    group.lastActivity = Math.max(group.lastActivity, session.lastActivity);
    groups.set(root, group);
    return groups;
  }, new Map<string, { root: string; name: string; sessions: Session[]; lastActivity: number }>()).values())
    .map((group) => ({ ...group, sessions: group.sessions.sort((a, b) => b.lastActivity - a.lastActivity) }))
    .sort((a, b) => b.lastActivity - a.lastActivity);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <img className="brand-mark" src="/icon.png" alt="" aria-hidden="true" />
          <span>tiny-claw</span>
        </div>
        <button className="refresh-btn" onClick={loadSessions} disabled={isLoading} title="刷新会话列表">
          {isLoading ? "…" : "↻"}
        </button>
      </div>
      <div className="sidebar-primary-action">
        {sidebarMode === "project" ? (
          <button onClick={onNewProject}><span aria-hidden="true">＋</span> 新建项目</button>
        ) : (
          <button onClick={onNewChat}><span aria-hidden="true">＋</span> 新对话</button>
        )}
      </div>
      <div className="session-section-label">{sidebarMode === "project" ? "项目" : "最近对话"}</div>
      <div className="session-list">
        {sidebarMode === "project" ? projectGroups.map((group) => (
          <section className={`project-group ${group.root === projectRoot ? "active" : ""}`} key={group.root}>
            <div className="project-group-header" onClick={() => onSelectSession(group.sessions[0])}>
              <span className="project-group-icon" aria-hidden="true">📁</span>
              <span className="project-group-title" title={group.root}>{group.name}</span>
              <button
                className="project-new-chat-btn"
                title={`在 ${group.name} 中新建对话`}
                aria-label={`在 ${group.name} 中新建对话`}
                onClick={(event) => {
                  event.stopPropagation();
                  onNewProjectChat(group.root);
                }}
              >＋</button>
              <button
                className="project-delete-btn"
                title={`删除项目 ${group.name}`}
                aria-label={`删除项目 ${group.name}`}
                disabled={deletingProjectRoot === group.root}
                onClick={(event) => void handleDeleteProject(group, event)}
              >{deletingProjectRoot === group.root ? "…" : "×"}</button>
            </div>
            <div className="project-conversation-list">
              {group.sessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-item project-conversation-item ${session.id === activeSessionId ? "active" : ""}`}
                  onClick={() => onSelectSession(session)}
                >
                  <div className="session-info">
                    <div className="session-id">{session.preview || "新对话"}</div>
                    <div className="session-time">{formatTime(session.lastActivity)}</div>
                  </div>
                  <button className="delete-btn" onClick={(event) => handleDelete(session.id, event)}>✕</button>
                </div>
              ))}
            </div>
          </section>
        )) : sessions.filter((session) => session.context.mode === "chat").map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
            onClick={() => { onSelectSession(s); }}
          >
            <div className="session-info">
              <div className="session-id">
                {formatId(s.id)}
              </div>
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
          className={`nav-btn ${currentView === "project" ? "active" : ""}`}
          onClick={() => onViewChange("project")}
        ><span aria-hidden="true">📁</span>项目</button>
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
