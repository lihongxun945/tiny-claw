import { useState, useCallback, useRef, useEffect } from "react";
import type { ExecutionMode, Message, ToolCallInfo, ProjectInfo, ProjectGitStatus, ProjectDiff, SessionPlan } from "../types.js";
import { fetchConfig, fetchProjectDiff, fetchProjectInfo, fetchProjectStatus } from "../lib/api.js";
import ChatView from "./ChatView.js";
import ChatInput from "./ChatInput.js";
import PlanProgress from "./PlanProgress.js";

interface Props {
  messages: Message[];
  streamingText: string;
  streamingStatus: string;
  streamingToolCalls: ToolCallInfo[];
  streamingApprovalId?: string;
  isStreaming: boolean;
  activeSessionId: string | null;
  isRefreshing?: boolean;
  onRefreshMessages: () => void;
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
  onApproveAndResume: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume: (approvalId: string) => Promise<void>;
  projectRoot: string | null;
  statusRefreshKey: number;
  onProjectChange: (path: string | null, signal?: AbortSignal) => Promise<void>;
  plan: SessionPlan | null;
  executionMode: ExecutionMode;
  onExecutionModeChange: (mode: ExecutionMode) => void;
}

export default function ProjectView({
  messages,
  streamingText,
  streamingStatus,
  streamingToolCalls,
  streamingApprovalId,
  isStreaming,
  activeSessionId,
  isRefreshing,
  onRefreshMessages,
  onSend,
  onStop,
  onApproveAndResume,
  onApproveTurnAndResume,
  projectRoot,
  statusRefreshKey,
  onProjectChange,
  plan,
  executionMode,
  onExecutionModeChange,
}: Props) {
  const [pathInput, setPathInput] = useState(projectRoot ?? "");
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState("");
  const [isOpeningProject, setIsOpeningProject] = useState(false);
  const [gitStatus, setGitStatus] = useState<ProjectGitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const [selectedDiff, setSelectedDiff] = useState<ProjectDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const openingRef = useRef(false);
  const openTimeoutMsRef = useRef(30_000);
  const canSelectDirectory = Boolean(window.tinyClawDesktop?.selectProjectDirectory);

  // 加载项目信息
  const loadProjectInfo = useCallback(async (projectPath: string, signal?: AbortSignal) => {
    setInfoLoading(true);
    setInfoError("");
    try {
      const result = await fetchProjectInfo(projectPath, signal);
      setInfo(result);
      return result;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      setInfoError(err instanceof Error ? err.message : "加载项目信息失败");
      setInfo(null);
    } finally {
      setInfoLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig().then((config) => {
      const timeout = (config.project as { openTimeoutMs?: unknown } | undefined)?.openTimeoutMs;
      if (typeof timeout === "number" && timeout >= 1000) openTimeoutMsRef.current = timeout;
    }).catch(() => {});
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!projectRoot) return;
    setStatusLoading(true);
    setStatusError("");
    try {
      setGitStatus(await fetchProjectStatus(projectRoot));
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "读取项目状态失败");
    } finally {
      setStatusLoading(false);
    }
  }, [projectRoot]);

  // 已有 projectRoot 时自动加载信息
  useEffect(() => {
    if (projectRoot) {
      setPathInput(projectRoot);
      loadProjectInfo(projectRoot);
    }
  }, [projectRoot, loadProjectInfo]);

  useEffect(() => {
    if (projectRoot) void refreshStatus();
  }, [projectRoot, statusRefreshKey, refreshStatus]);

  const runOpenProject = useCallback(async (getPath: () => Promise<string | null>) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setIsOpeningProject(true);
    setInfoError("");
    let timeout: number | undefined;
    try {
      const selectedPath = await getPath();
      if (!selectedPath) return;
      setPathInput(selectedPath);
      const controller = new AbortController();
      timeout = window.setTimeout(() => controller.abort(), openTimeoutMsRef.current);
      const result = await loadProjectInfo(selectedPath, controller.signal);
      if (!result) return;
      await onProjectChange(result.root, controller.signal);
    } catch (err) {
      const message = err instanceof DOMException && err.name === "AbortError"
        ? `打开项目超时（${openTimeoutMsRef.current}ms），请重试`
        : err instanceof Error ? err.message : "打开项目失败";
      setInfoError(message);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      openingRef.current = false;
      setIsOpeningProject(false);
    }
  }, [loadProjectInfo, onProjectChange]);

  const handleOpenProject = useCallback(async () => {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    await runOpenProject(async () => trimmed);
  }, [pathInput, runOpenProject]);

  const handleSelectDirectory = useCallback(async () => {
    await runOpenProject(async () => window.tinyClawDesktop?.selectProjectDirectory() ?? null);
  }, [runOpenProject]);

  const handleSelectDiff = useCallback(async (file: string) => {
    if (!projectRoot) return;
    setDiffLoading(true);
    setDiffError("");
    try {
      setSelectedDiff(await fetchProjectDiff(projectRoot, file));
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : "读取 diff 失败");
    } finally {
      setDiffLoading(false);
    }
  }, [projectRoot]);

  const handleCloseProject = useCallback(() => {
    void onProjectChange(null);
    setInfo(null);
    setInfoError("");
    setPathInput("");
  }, [onProjectChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleOpenProject();
      }
    },
    [handleOpenProject],
  );

  return (
    <>
      {/* 项目选择器 / 项目信息栏 */}
      {!projectRoot ? (
        <div className="project-picker">
          <div className="project-picker-inner">
            <div className="project-picker-icon" aria-hidden="true">📁</div>
            <div className="project-picker-body">
              <h1 className="project-picker-title">项目开发模式</h1>
              <p className="project-picker-desc">
                输入项目根目录路径，tiny-claw 将在该项目上下文中工作：
                工具（bash、文件读写）的相对路径均基于项目根目录解析，
                技术栈与项目规则会注入系统提示词，Git 状态可在项目栏查看。
              </p>
              <div className="project-picker-form">
                <input
                  ref={inputRef}
                  type="text"
                  className="project-picker-input"
                  placeholder="例如 /Users/you/my-project"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isOpeningProject}
                  autoFocus
                />
                <button className="project-picker-btn" onClick={handleOpenProject} disabled={!pathInput.trim() || isOpeningProject}>
                  {isOpeningProject ? "正在打开…" : "打开项目"}
                </button>
                {canSelectDirectory && (
                  <button className="project-picker-btn project-picker-select-btn" onClick={handleSelectDirectory} disabled={isOpeningProject}>
                    {isOpeningProject ? "正在打开…" : "选择目录"}
                  </button>
                )}
              </div>
              {infoError && <p className="project-picker-error">{infoError}</p>}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* 项目信息栏 */}
          <div className="project-toolbar">
            <div className="project-toolbar-left">
              <span className="project-toolbar-icon" aria-hidden="true">📁</span>
              <div className="project-toolbar-info">
                <span className="project-toolbar-path">{projectRoot}</span>
                {infoLoading ? (
                  <span className="project-toolbar-meta">加载中…</span>
                ) : infoError ? (
                  <span className="project-toolbar-meta project-toolbar-error">{infoError}</span>
                ) : info ? (
                  <span className="project-toolbar-meta">
                    {info.stack.length > 0 ? info.stack.join("、") : "未检测到明显技术栈"}
                    {gitStatus?.isRepository ? ` · ${gitStatus.branch} · ${gitStatus.clean ? "工作区干净" : `${gitStatus.changedCount} 个变更`}` : ""}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="project-toolbar-right">
              {statusError && <span className="project-toolbar-meta project-toolbar-error">{statusError}</span>}
              <button className="project-toolbar-action" onClick={() => void refreshStatus()} disabled={statusLoading}>
                {statusLoading ? "刷新中…" : "刷新"}
              </button>
              {gitStatus?.isRepository && (
                <button className="project-toolbar-action" onClick={() => setChangesOpen((open) => !open)}>
                  变更 {gitStatus.changedCount}
                </button>
              )}
              {info && info.rules !== "(无)" && (
                <span className="project-toolbar-badge" title="已加载项目规则">
                  规则 ✓
                </span>
              )}
              <button
                className="project-toolbar-close"
                onClick={handleCloseProject}
                title="关闭项目"
              >
                ✕ 关闭
              </button>
            </div>
          </div>

          {changesOpen && gitStatus && (
            <div className="project-changes-panel">
              <div className="project-changes-files">
                {gitStatus.files.length === 0 ? <p>工作区没有变更</p> : gitStatus.files.map((file) => (
                  <button key={`${file.path}:${file.previousPath ?? ""}`} onClick={() => void handleSelectDiff(file.path)}>
                    <span className="project-file-status">{file.untracked ? "??" : `${file.indexStatus}${file.workTreeStatus}`}</span>
                    <span>{file.path}</span>
                  </button>
                ))}
              </div>
              <div className="project-diff-view">
                {diffLoading ? "正在读取 diff…" : diffError ? diffError : selectedDiff ? (
                  <>
                    <strong>{selectedDiff.path}</strong>
                    {selectedDiff.staged && <pre>{selectedDiff.staged}</pre>}
                    {selectedDiff.unstaged && <pre>{selectedDiff.unstaged}</pre>}
                    {!selectedDiff.staged && !selectedDiff.unstaged && <p>该文件暂无可显示的文本 diff。</p>}
                    {selectedDiff.truncated && <p>Diff 已按配置截断。</p>}
                  </>
                ) : "选择文件查看 diff"}
              </div>
            </div>
          )}

          {/* 项目聊天视图 */}
          <ChatView
            messages={messages}
            streamingText={streamingText}
            streamingStatus={streamingStatus}
            streamingToolCalls={streamingToolCalls}
            streamingApprovalId={streamingApprovalId}
            isStreaming={isStreaming}
            activeSessionId={activeSessionId}
            isRefreshing={isRefreshing}
            onRefreshMessages={onRefreshMessages}
            onApproveAndResume={onApproveAndResume}
            onApproveTurnAndResume={onApproveTurnAndResume}
          />
          <PlanProgress plan={plan} />
          <ChatInput onSend={onSend} onStop={onStop} disabled={isStreaming} executionMode={executionMode} onExecutionModeChange={onExecutionModeChange} />
        </>
      )}
    </>
  );
}
