import { useState, useCallback, useEffect, useRef } from "react";
import type { Attachment, ExecutionMode, Message, SessionPlan, ToolCallInfo, Session } from "./types.js";
import { streamChat, streamApprovalResume, fetchHistoryMessages, fetchHistorySessions, fetchSessionPlans, cancelSession, uploadImage, createSession, updateSessionExecutionMode } from "./lib/api.js";
import { mergeApprovalResume } from "./lib/message-merge.js";
import ChatView from "./components/ChatView.js";
import ChatInput from "./components/ChatInput.js";
import SessionSidebar from "./components/SessionSidebar.js";
import LogViewer from "./components/LogViewer.js";
import ConfigEditor from "./components/ConfigEditor.js";
import MemoryManager from "./components/MemoryManager.js";
import ProjectView from "./components/ProjectView.js";
import PlanProgress from "./components/PlanProgress.js";

type View = "chat" | "project" | "memory" | "logs" | "config";

interface SessionUiState {
  messages: Message[];
  streamingText: string;
  streamingStatus: string;
  streamingToolCalls: ToolCallInfo[];
  streamingApprovalId?: string;
  isStreaming: boolean;
  loaded: boolean;
  plan: SessionPlan | null;
  planLoaded: boolean;
}

function emptySessionState(): SessionUiState {
  return {
    messages: [],
    streamingText: "",
    streamingStatus: "",
    streamingToolCalls: [],
    streamingApprovalId: undefined,
    isStreaming: false,
    loaded: false,
    plan: null,
    planLoaded: false,
  };
}

function readHashSession(): string | null {
  const hash = location.hash;
  const m = hash.match(/sid=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function writeHashSession(id: string | null) {
  if (id) {
    history.replaceState(null, "", `#sid=${encodeURIComponent(id)}`);
  } else {
    history.replaceState(null, "", location.pathname);
  }
}

function findLastMatchingUserMessage(messages: Message[], text: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && message.text === text) return index;
  }
  return -1;
}

export default function App() {
  const [view, setView] = useState<View>("chat");
  const [sidebarMode, setSidebarMode] = useState<"chat" | "project">("chat");
  const [sessionStates, setSessionStates] = useState<Record<string, SessionUiState>>({});
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(readHashSession);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [projectStatusRefreshKey, setProjectStatusRefreshKey] = useState(0);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("normal");
  const activeSessionRef = useRef<string | null>(activeSessionId);
  const viewRef = useRef<View>(view);
  const lastChatSessionRef = useRef<string | null>(null);
  const lastProjectSessionRef = useRef<string | null>(null);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const sessionModesRef = useRef(new Map<string, ExecutionMode>());

  const activeState = activeSessionId ? sessionStates[activeSessionId] ?? emptySessionState() : emptySessionState();

  const updateSessionState = useCallback((sessionId: string, update: (state: SessionUiState) => SessionUiState) => {
    setSessionStates((previous) => ({
      ...previous,
      [sessionId]: update(previous[sessionId] ?? emptySessionState()),
    }));
  }, []);

  const refreshSessionPlan = useCallback(async (sessionId: string) => {
    try {
      const plans = await fetchSessionPlans(sessionId);
      const plan = [...plans].reverse().find((item) => item.status === "planning" || item.status === "executing") ?? null;
      updateSessionState(sessionId, (state) => ({ ...state, plan, planLoaded: true }));
    } catch {
      updateSessionState(sessionId, (state) => ({ ...state, planLoaded: true }));
    }
  }, [updateSessionState]);

  const consumeAgentStream = useCallback(async (
    sourceSessionId: string,
    events: AsyncIterable<{ event: string; data: unknown }>,
    approvalId?: string,
    turnId?: string,
  ) => {
    let fullText = "";
    const toolCalls: ToolCallInfo[] = [];

    for await (const event of events) {
      const d = event.data as Record<string, unknown>;
      switch (event.event) {
        case "status":
          updateSessionState(sourceSessionId, (state) => ({
            ...state,
            streamingStatus: typeof d.message === "string" ? d.message : "正在处理",
          }));
          break;
        case "text_delta":
          fullText += (d.text as string) ?? "";
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingText: fullText, streamingStatus: "" }));
          break;
        case "tool_call":
          toolCalls.push({
            id: typeof d.tool_call_id === "string" ? d.tool_call_id : undefined,
            name: (d.name as string) ?? "",
            input: (d.input as Record<string, unknown>) ?? {},
          });
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingToolCalls: [...toolCalls], streamingStatus: "" }));
          break;
        case "tool_result": {
          const toolCallId = typeof d.tool_call_id === "string" ? d.tool_call_id : undefined;
          const name = (d.name as string) ?? "";
          const tc = toolCalls.find((t) => (
            t.result === undefined && (toolCallId ? t.id === toolCallId : t.name === name)
          ));
          if (tc) tc.result = (d.result as string) ?? "";
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingToolCalls: [...toolCalls] }));
          if (name === "plan_create" || name === "plan_update") await refreshSessionPlan(sourceSessionId);
          break;
        }
        case "done": {
          const sid = (d.session_id as string) || sourceSessionId;
          const completedText = typeof d.text === "string" ? d.text : fullText;
          const plans = await fetchSessionPlans(sid).catch(() => []);
          const completedPlan = turnId ? plans.find((item) => item.turnId === turnId && (item.status === "completed" || item.status === "failed")) : undefined;
          const assistantMessage = { role: "assistant" as const, text: completedText, toolCalls: [...toolCalls], timestamp: Date.now(), turnId, plan: completedPlan };
          setSessionStates((previous) => {
            const source = previous[sourceSessionId] ?? emptySessionState();
            const target = previous[sid] ?? emptySessionState();
            const baseMessages = sid === sourceSessionId || target.loaded ? target.messages : source.messages;
            const next = {
              ...previous,
              [sid]: {
                ...target,
                messages: d.clear_messages === true
                  ? [assistantMessage]
                  : approvalId
                    ? mergeApprovalResume(baseMessages, approvalId, completedText, toolCalls, { turnId, plan: completedPlan })
                    : [...baseMessages, assistantMessage],
                streamingText: "",
                streamingStatus: "",
                streamingToolCalls: [],
                streamingApprovalId: undefined,
                loaded: true,
              },
            };
            if (sid !== sourceSessionId) {
              next[sourceSessionId] = {
                ...source,
                streamingText: "",
                streamingStatus: "",
                streamingToolCalls: [],
                streamingApprovalId: undefined,
              };
            }
            return next;
          });
          if (activeSessionRef.current === sourceSessionId) {
            activeSessionRef.current = sid;
            setActiveSessionId(sid);
          }
          if (lastChatSessionRef.current === sourceSessionId) lastChatSessionRef.current = sid;
          if (lastProjectSessionRef.current === sourceSessionId) lastProjectSessionRef.current = sid;
          if (lastProjectSessionRef.current === sid) setProjectStatusRefreshKey((key) => key + 1);
          setSidebarRefreshKey((k) => k + 1);
          await refreshSessionPlan(sid);
          break;
        }
        case "error":
          updateSessionState(sourceSessionId, (state) => ({
            ...state,
            messages: [...state.messages, {
              role: "assistant",
              text: `Error: ${(d.message as string) ?? "未知错误"}`,
              toolCalls: [],
              timestamp: Date.now(),
            }],
            streamingText: "",
            streamingStatus: "",
            streamingToolCalls: [],
            streamingApprovalId: undefined,
          }));
          await refreshSessionPlan(sourceSessionId);
          break;
      }
    }
  }, [refreshSessionPlan, updateSessionState]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 首次加载时恢复各视图最近使用的会话；URL 中的会话优先。
  useEffect(() => {
    const sid = readHashSession();
    fetchHistorySessions().then((sessions) => {
      sessionModesRef.current = new Map(sessions.map((item) => [item.id, item.executionMode ?? "normal"]));
      const latestChat = sessions.find((item) => item.context.mode === "chat");
      const latestProject = sessions.find((item) => item.context.mode === "project");
      lastChatSessionRef.current = latestChat?.id ?? null;
      lastProjectSessionRef.current = latestProject?.id ?? null;
      if (latestProject?.context.project) {
        setProjectRoot(latestProject.context.project.root);
        setProjectName(latestProject.context.project.name);
      }

      const session = sid ? sessions.find((item) => item.id === sid) : undefined;
      setExecutionMode(session?.executionMode ?? "normal");
      if (session?.context.mode === "project") {
        setView("project");
        setSidebarMode("project");
        setProjectRoot(session.context.project?.root ?? null);
        setProjectName(session.context.project?.name ?? null);
        lastProjectSessionRef.current = sid;
      } else if (session) {
        setView("chat");
        setSidebarMode("chat");
        lastChatSessionRef.current = sid;
      } else if (!sid && viewRef.current === "project" && latestProject) {
        activeSessionRef.current = latestProject.id;
        setActiveSessionId(latestProject.id);
      }
    }).catch(() => {});
    if (sid) {
      fetchHistoryMessages(sid)
        .then((msgs) => updateSessionState(sid, (state) => ({ ...state, messages: msgs, loaded: true })))
        .catch(() => {});
    }
  }, [updateSessionState]);

  // activeSessionId 变化时同步到 URL hash
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
    writeHashSession(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSessionId) void refreshSessionPlan(activeSessionId);
  }, [activeSessionId, refreshSessionPlan]);

  const handleSend = useCallback(async (text: string, files: File[]) => {
    const turnId = crypto.randomUUID();
    let sessionId = activeSessionId;
    if (!sessionId && view === "project" && projectRoot) {
      const created = await createSession("project", projectRoot, true);
      sessionId = created.id;
      lastProjectSessionRef.current = sessionId;
      setProjectName(created.context.project?.name ?? null);
    } else if (!sessionId) {
      sessionId = crypto.randomUUID();
      lastChatSessionRef.current = sessionId;
    }
    abortControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    abortControllersRef.current.set(sessionId, controller);
    updateSessionState(sessionId, (state) => ({
      ...state,
      isStreaming: true,
      streamingText: "",
      streamingStatus: "",
      streamingToolCalls: [],
      streamingApprovalId: undefined,
      loaded: true,
      plan: executionMode === "plan" ? null : state.plan,
      planLoaded: executionMode === "plan" ? true : state.planLoaded,
    }));
    try {
      if (!activeSessionId) {
        activeSessionRef.current = sessionId;
        setActiveSessionId(sessionId);
      }
      const attachments: Attachment[] = [];
      for (const file of files) {
        attachments.push(await uploadImage(sessionId, file));
      }
      updateSessionState(sessionId, (state) => ({
        ...state,
        messages: [...state.messages, { role: "user", text, toolCalls: [], attachments, timestamp: Date.now(), turnId }],
      }));
      await consumeAgentStream(sessionId, streamChat(
        text,
        sessionId,
        attachments.map((attachment) => attachment.id),
        controller.signal,
        executionMode,
        turnId,
      ), undefined, turnId);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      try {
        const persisted = await fetchHistoryMessages(sessionId);
        const userIndex = findLastMatchingUserMessage(persisted, text);
        const recovered = userIndex >= 0 && persisted.slice(userIndex + 1).some((message) => (
          message.role === "assistant" && (message.text.length > 0 || message.toolCalls.length > 0)
        ));
        if (recovered) {
          updateSessionState(sessionId, (state) => ({
            ...state,
            messages: persisted,
            streamingText: "",
            streamingStatus: "",
            streamingToolCalls: [],
            streamingApprovalId: undefined,
            loaded: true,
          }));
          setSidebarRefreshKey((key) => key + 1);
          return;
        }
      } catch {
        // Fall through to the connection error when persisted recovery is unavailable.
      }
      const msg = err instanceof Error ? err.message : String(err);
      updateSessionState(sessionId, (state) => ({
        ...state,
        messages: [...state.messages, { role: "assistant", text: `连接失败: ${msg}`, toolCalls: [], timestamp: Date.now() }],
      }));
    } finally {
      if (abortControllersRef.current.get(sessionId) === controller) {
        abortControllersRef.current.delete(sessionId);
      }
      updateSessionState(sessionId, (state) => ({
        ...state,
        isStreaming: false,
        streamingStatus: "",
        streamingApprovalId: undefined,
      }));
    }
  }, [activeSessionId, consumeAgentStream, updateSessionState, projectRoot, view, executionMode]);

  const resumeApproval = useCallback(async (approvalId: string, allowTurn: boolean) => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    abortControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    abortControllersRef.current.set(sessionId, controller);
    updateSessionState(sessionId, (state) => ({
      ...state,
      isStreaming: true,
      streamingText: "",
      streamingStatus: "",
      streamingToolCalls: [],
      streamingApprovalId: approvalId,
    }));
    try {
      await consumeAgentStream(sessionId, streamApprovalResume(approvalId, allowTurn, controller.signal), approvalId, activeState.plan?.turnId);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      updateSessionState(sessionId, (state) => ({
        ...state,
        messages: [...state.messages, { role: "assistant", text: `连接失败: ${msg}`, toolCalls: [], timestamp: Date.now() }],
      }));
    } finally {
      if (abortControllersRef.current.get(sessionId) === controller) {
        abortControllersRef.current.delete(sessionId);
      }
      updateSessionState(sessionId, (state) => ({
        ...state,
        isStreaming: false,
        streamingStatus: "",
        streamingApprovalId: undefined,
      }));
    }
  }, [activeSessionId, activeState.plan?.turnId, consumeAgentStream, updateSessionState]);

  const handleApproveAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, false),
    [resumeApproval],
  );

  const handleApproveTurnAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, true),
    [resumeApproval],
  );

  const handleNewChat = useCallback(() => {
    viewRef.current = "chat";
    setView("chat");
    setSidebarMode("chat");
    lastChatSessionRef.current = null;
    activeSessionRef.current = null;
    setActiveSessionId(null);
    setExecutionMode("normal");
  }, []);

  const handleNewProject = useCallback(() => {
    viewRef.current = "project";
    setView("project");
    setSidebarMode("project");
    setProjectRoot(null);
    setProjectName(null);
    activeSessionRef.current = null;
    setActiveSessionId(null);
    setExecutionMode("normal");
  }, []);

  const handleNewProjectChat = useCallback(async (targetProjectRoot: string) => {
    viewRef.current = "project";
    setView("project");
    setSidebarMode("project");
    const created = await createSession("project", targetProjectRoot, true);
    setProjectRoot(created.context.project?.root ?? targetProjectRoot);
    lastProjectSessionRef.current = created.id;
    activeSessionRef.current = created.id;
    setActiveSessionId(created.id);
    setProjectName(created.context.project?.name ?? null);
    sessionModesRef.current.set(created.id, created.executionMode ?? "normal");
    setExecutionMode(created.executionMode ?? "normal");
    updateSessionState(created.id, (state) => ({ ...state, loaded: true }));
    setSidebarRefreshKey((key) => key + 1);
  }, [updateSessionState]);

  const handleProjectChange = useCallback(async (path: string | null, signal?: AbortSignal) => {
    setSidebarMode("project");
    if (!path) {
      setProjectRoot(null);
      setProjectName(null);
      lastProjectSessionRef.current = null;
      activeSessionRef.current = null;
      setActiveSessionId(null);
      return;
    }
    const created = await createSession("project", path, true, signal);
    setProjectRoot(created.context.project?.root ?? path);
    setProjectName(created.context.project?.name ?? null);
    lastProjectSessionRef.current = created.id;
    activeSessionRef.current = created.id;
    setActiveSessionId(created.id);
    sessionModesRef.current.set(created.id, created.executionMode ?? "normal");
    setExecutionMode(created.executionMode ?? "normal");
    updateSessionState(created.id, (state) => ({ ...state, loaded: true }));
    setSidebarRefreshKey((key) => key + 1);
  }, [updateSessionState]);

  const handleViewChange = useCallback((nextView: View) => {
    viewRef.current = nextView;
    setView(nextView);
    if (nextView === "chat") {
      setSidebarMode("chat");
      activeSessionRef.current = lastChatSessionRef.current;
      setActiveSessionId(lastChatSessionRef.current);
      setExecutionMode(lastChatSessionRef.current ? sessionModesRef.current.get(lastChatSessionRef.current) ?? "normal" : "normal");
    } else if (nextView === "project") {
      setSidebarMode("project");
      activeSessionRef.current = lastProjectSessionRef.current;
      setActiveSessionId(lastProjectSessionRef.current);
      setExecutionMode(lastProjectSessionRef.current ? sessionModesRef.current.get(lastProjectSessionRef.current) ?? "normal" : "normal");
    }
  }, []);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    abortControllersRef.current.get(activeSessionId)?.abort();
    abortControllersRef.current.delete(activeSessionId);
    cancelSession(activeSessionId).catch(() => {});
    updateSessionState(activeSessionId, (state) => ({
      ...state,
      isStreaming: false,
      streamingApprovalId: undefined,
    }));
  }, [activeSessionId, updateSessionState]);

  const handleSelectSession = useCallback(async (session: Session) => {
    const id = session.id;
    if (session.context.mode === "project") {
      viewRef.current = "project";
      setView("project");
      setSidebarMode("project");
      setProjectRoot(session.context.project?.root ?? null);
      setProjectName(session.context.project?.name ?? null);
      lastProjectSessionRef.current = id;
    } else {
      viewRef.current = "chat";
      setView("chat");
      setSidebarMode("chat");
      lastChatSessionRef.current = id;
    }
    activeSessionRef.current = id;
    setActiveSessionId(id);
    sessionModesRef.current.set(id, session.executionMode ?? "normal");
    setExecutionMode(session.executionMode ?? "normal");
    if (sessionStates[id]?.loaded) return;
    try {
      const msgs = await fetchHistoryMessages(id);
      updateSessionState(id, (state) => ({ ...state, messages: msgs, loaded: true }));
    } catch {
      updateSessionState(id, (state) => ({ ...state, messages: [], loaded: true }));
    }
  }, [sessionStates, updateSessionState]);

  const handleExecutionModeChange = useCallback((mode: ExecutionMode) => {
    const previous = executionMode;
    setExecutionMode(mode);
    if (!activeSessionId) return;
    sessionModesRef.current.set(activeSessionId, mode);
    void updateSessionExecutionMode(activeSessionId, mode).catch(() => {
      sessionModesRef.current.set(activeSessionId, previous);
      setExecutionMode(previous);
    });
  }, [activeSessionId, executionMode]);

  const handleSessionDeleted = useCallback((id: string) => {
    abortControllersRef.current.get(id)?.abort();
    abortControllersRef.current.delete(id);
    setSessionStates((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    if (activeSessionId === id) {
      activeSessionRef.current = null;
      setActiveSessionId(null);
    }
    if (lastChatSessionRef.current === id) lastChatSessionRef.current = null;
    if (lastProjectSessionRef.current === id) lastProjectSessionRef.current = null;
  }, [activeSessionId]);

  const handleProjectDeleted = useCallback((root: string, sessionIds: string[]) => {
    const deletedIds = new Set(sessionIds);
    for (const id of deletedIds) {
      abortControllersRef.current.get(id)?.abort();
      abortControllersRef.current.delete(id);
      sessionModesRef.current.delete(id);
    }
    setSessionStates((previous) => Object.fromEntries(
      Object.entries(previous).filter(([id]) => !deletedIds.has(id)),
    ));
    if (activeSessionRef.current && deletedIds.has(activeSessionRef.current)) {
      activeSessionRef.current = null;
      setActiveSessionId(null);
      setExecutionMode("normal");
    }
    if (lastProjectSessionRef.current && deletedIds.has(lastProjectSessionRef.current)) {
      lastProjectSessionRef.current = null;
    }
    if (projectRoot === root) {
      setProjectRoot(null);
      setProjectName(null);
    }
  }, [projectRoot]);

  const handleRefreshMessages = useCallback(async () => {
    if (!activeSessionId || activeState.isStreaming || isRefreshingMessages) return;
    setIsRefreshingMessages(true);
    try {
      const msgs = await fetchHistoryMessages(activeSessionId);
      updateSessionState(activeSessionId, (state) => ({ ...state, messages: msgs, loaded: true }));
    } catch {
      // ignore
    } finally {
      setIsRefreshingMessages(false);
    }
  }, [activeSessionId, activeState.isStreaming, isRefreshingMessages, updateSessionState]);

  return (
    <div className="app">
      <SessionSidebar
        activeSessionId={activeSessionId}
        currentView={view}
        sidebarMode={sidebarMode}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onNewProject={handleNewProject}
        onNewProjectChat={handleNewProjectChat}
        onSessionDeleted={handleSessionDeleted}
        onProjectDeleted={handleProjectDeleted}
        onViewChange={handleViewChange}
        refreshKey={sidebarRefreshKey}
        projectRoot={projectRoot}
      />
      <div className="chat-area">
        {view === "chat" && (
          <>
            <ChatView
              messages={activeState.messages}
              streamingText={activeState.streamingText}
              streamingStatus={activeState.streamingStatus}
              streamingToolCalls={activeState.streamingToolCalls}
              streamingApprovalId={activeState.streamingApprovalId}
              isStreaming={activeState.isStreaming}
              activeSessionId={activeSessionId}
              isRefreshing={isRefreshingMessages}
              onRefreshMessages={handleRefreshMessages}
              onApproveAndResume={handleApproveAndResume}
              onApproveTurnAndResume={handleApproveTurnAndResume}
            />
            <PlanProgress plan={activeState.plan} />
            <ChatInput onSend={handleSend} onStop={handleStop} disabled={activeState.isStreaming} executionMode={executionMode} onExecutionModeChange={handleExecutionModeChange} />
          </>
        )}
        {view === "project" && (
          <ProjectView
            messages={activeState.messages}
            streamingText={activeState.streamingText}
            streamingStatus={activeState.streamingStatus}
            streamingToolCalls={activeState.streamingToolCalls}
            streamingApprovalId={activeState.streamingApprovalId}
            isStreaming={activeState.isStreaming}
            activeSessionId={activeSessionId}
            isRefreshing={isRefreshingMessages}
            onRefreshMessages={handleRefreshMessages}
            onSend={handleSend}
            onStop={handleStop}
            onApproveAndResume={handleApproveAndResume}
            onApproveTurnAndResume={handleApproveTurnAndResume}
            projectRoot={projectRoot}
            statusRefreshKey={projectStatusRefreshKey}
            onProjectChange={handleProjectChange}
            plan={activeState.plan}
            executionMode={executionMode}
            onExecutionModeChange={handleExecutionModeChange}
          />
        )}
        {view === "memory" && <MemoryManager />}
        {view === "logs" && <LogViewer />}
        {view === "config" && <ConfigEditor />}
      </div>
    </div>
  );
}
