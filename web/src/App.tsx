import { useState, useCallback, useEffect, useRef } from "react";
import type { Attachment, ContextTokenUsage, ExecutionMode, Message, PermissionMode, SessionPlan, ToolCallInfo, Session } from "./types.js";
import { streamChat, streamApprovalResume, fetchConfig, fetchHistoryMessages, fetchHistorySessions, fetchSessionPlans, fetchSessionPlanState, cancelSession, uploadImage, createSession, updateConfig, updateSessionExecutionMode } from "./lib/api.js";
import { mergeApprovalResume } from "./lib/message-merge.js";
import { streamSessionEvents } from "./lib/sse-client.js";
import ChatView from "./components/ChatView.js";
import ChatInput from "./components/ChatInput.js";
import SessionSidebar from "./components/SessionSidebar.js";
import LogViewer from "./components/LogViewer.js";
import ConfigEditor from "./components/ConfigEditor.js";
import PluginManagerView from "./components/PluginManagerView.js";
import MemoryManager from "./components/MemoryManager.js";
import ProjectView from "./components/ProjectView.js";
import PlanProgress from "./components/PlanProgress.js";
import { readInitialTheme, saveTheme, type Theme } from "./lib/theme.js";

type View = "chat" | "project" | "memory" | "logs" | "plugins" | "config";

interface SessionUiState {
  isStopping?: boolean;
  messages: Message[];
  summaryNotice?: { state: "completed" | "failed"; message: string };
  streamingText: string;
  streamingStatus: string;
  streamingToolCalls: ToolCallInfo[];
  streamingApprovalId?: string;
  streamingTurnId?: string;
  isStreaming: boolean;
  loaded: boolean;
  plan: SessionPlan | null;
  planLoaded: boolean;
  planExecutionTurnId?: string;
  contextUsage?: ContextTokenUsage;
  backendBusy: boolean;
  awaitingApproval: boolean;
  run?: import("./types.js").RunView;
  latestPlans?: SessionPlan[];
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
    backendBusy: false,
    awaitingApproval: false,
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
  const [reconnectKey, setReconnectKey] = useState(0);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [projectStatusRefreshKey, setProjectStatusRefreshKey] = useState(0);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("normal");
  const [globalPermissionMode, setGlobalPermissionMode] = useState<PermissionMode>("auto");
  const [projectPermissionMode, setProjectPermissionMode] = useState<PermissionMode>("auto");
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const activeSessionRef = useRef<string | null>(activeSessionId);
  const viewRef = useRef<View>(view);
  const lastChatSessionRef = useRef<string | null>(null);
  const lastProjectSessionRef = useRef<string | null>(null);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const sessionModesRef = useRef(new Map<string, ExecutionMode>());
  const backendBusyRef = useRef(new Map<string, boolean>());
  const backendApprovalRef = useRef(new Map<string, boolean>());
  const planRequestsRef = useRef(new Map<string, number>());

  const activeState = activeSessionId ? sessionStates[activeSessionId] ?? emptySessionState() : emptySessionState();
  const activeBusy = activeState.isStreaming || activeState.backendBusy || activeState.awaitingApproval;
  useEffect(() => {
    if (activeSessionId && !activeBusy && activeState.isStopping) {
      updateSessionState(activeSessionId, (state) => ({ ...state, isStopping: false }));
    }
  }, [activeSessionId, activeBusy, activeState.isStopping]);

  useEffect(() => {
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    fetchConfig().then((config) => {
      const globalMode = (config.security as { mode?: unknown } | undefined)?.mode;
      const projectMode = ((config.project as { security?: { mode?: unknown } } | undefined)?.security)?.mode;
      if (globalMode === "ask" || globalMode === "auto" || globalMode === "allow") setGlobalPermissionMode(globalMode);
      if (projectMode === "ask" || projectMode === "auto" || projectMode === "allow") setProjectPermissionMode(projectMode);
    }).catch(() => setPermissionError("读取权限配置失败"));
  }, []);

  const updateSessionState = useCallback((sessionId: string, update: (state: SessionUiState) => SessionUiState) => {
    setSessionStates((previous) => ({
      ...previous,
      [sessionId]: update(previous[sessionId] ?? emptySessionState()),
    }));
  }, []);

  const refreshSessionPlan = useCallback(async (sessionId: string) => {
    const request = (planRequestsRef.current.get(sessionId) ?? 0) + 1;
    planRequestsRef.current.set(sessionId, request);
    try {
      const snapshot = await fetchSessionPlanState(sessionId);
      if (planRequestsRef.current.get(sessionId) !== request) return;
      updateSessionState(sessionId, (state) => ({
        ...state,
        plan: snapshot.activePlan,
        planExecutionTurnId: snapshot.currentTurnId,
        planLoaded: true,
        run: snapshot.run,
        latestPlans: snapshot.plans,
        ...(snapshot.run ? {
          backendBusy: snapshot.run.state === "running",
          streamingStatus: snapshot.run.state === "running" && snapshot.run.status ? snapshot.run.status.message : state.streamingStatus,
          summaryNotice: snapshot.run.state === "interrupted" || snapshot.run.state === "cancelled" ? { state: "failed" as const, message: snapshot.run.reason ?? "运行已中断" } : state.summaryNotice,
        } : {}),
        messages: state.messages.map((message) => message.plan && message.turnId === snapshot.currentTurnId
          ? { ...message, plan: snapshot.plans.find((plan) => plan.id === message.plan?.id) ?? message.plan }
          : message),
      }));
    } catch {
      if (planRequestsRef.current.get(sessionId) !== request) return;
      updateSessionState(sessionId, (state) => ({ ...state, planLoaded: true }));
    }
  }, [updateSessionState]);

  const handleSessionsLoaded = useCallback((sessions: Session[]) => {
    sessionModesRef.current = new Map(sessions.map((item) => [item.id, item.executionMode ?? "normal"]));
    const nextBusy = new Map(sessions.map((item) => [item.id, item.busy === true]));
    const activeId = activeSessionRef.current;
    const activeWasBusy = activeId ? backendBusyRef.current.get(activeId) === true : false;
    const activeIsBusy = activeId ? nextBusy.get(activeId) === true : false;
    const approvalEnded = activeId && backendApprovalRef.current.get(activeId) === true
      && sessions.some((session) => session.id === activeId && session.attention !== "approval");
    backendApprovalRef.current = new Map(sessions.map((session) => [session.id, session.attention === "approval"]));
    backendBusyRef.current = nextBusy;
    setReconnectKey((key) => key + 1);

    for (const session of sessions) {
      updateSessionState(session.id, (state) => ({
        ...state,
        backendBusy: session.busy === true,
        awaitingApproval: session.attention === "approval",
      }));
    }
    if (activeId && activeIsBusy && !abortControllersRef.current.has(activeId)) void refreshSessionPlan(activeId);

    if (activeId && ((activeWasBusy && !activeIsBusy) || approvalEnded) && !abortControllersRef.current.has(activeId)) {
      fetchHistoryMessages(activeId)
        .then((messages) => updateSessionState(activeId, (state) => ({ ...state, messages, loaded: true })))
        .catch(() => {});
      void refreshSessionPlan(activeId);
    }
  }, [refreshSessionPlan, updateSessionState]);

  const consumeAgentStream = useCallback(async (
    sourceSessionId: string,
    events: AsyncIterable<{ event: string; data: unknown }>,
    approvalId?: string,
    turnId?: string,
  ) => {
    let fullText = "";
    let sequence = -1;
    let currentRun: import("./types.js").RunView | undefined;
    const toolCalls: ToolCallInfo[] = [];

    for await (const event of events) {
      const d = event.data as Record<string, unknown>;
      if (typeof d.sequence === "number") {
        if (d.sequence <= sequence) continue;
        sequence = d.sequence;
      }
      switch (event.event) {
        case "run_state": {
          const run = d.run as unknown as import("./types.js").RunView;
          currentRun = run;
          turnId = run.turnId;
          updateSessionState(sourceSessionId, (state) => ({ ...state,
            run, streamingTurnId: run.turnId, backendBusy: run.state === "running",
            summaryNotice: run.state === "interrupted" || run.state === "cancelled" ? { state: "failed", message: run.reason ?? "运行已中断" } : state.summaryNotice,
            awaitingApproval: run.state === "waiting_approval",
            streamingStatus: run.state === "interrupted" ? run.reason ?? "运行已中断" : run.status?.message ?? state.streamingStatus,
          }));
          break;
        }
        case "snapshot":
          currentRun = d.run as typeof currentRun;
          turnId = typeof d.turnId === "string" ? d.turnId : turnId;
          approvalId = typeof d.approvalId === "string" ? d.approvalId : undefined;
          fullText = typeof d.text === "string" ? d.text : "";
          toolCalls.splice(0, toolCalls.length, ...((d.toolCalls as ToolCallInfo[]) ?? []));
          updateSessionState(sourceSessionId, (state) => ({
            ...state, streamingTurnId: turnId, streamingText: fullText,
            streamingToolCalls: [...toolCalls], streamingStatus: String(d.status ?? ""), streamingApprovalId: approvalId,
            ...(d.run ? { backendBusy: (d.run as { state: string }).state === "running", awaitingApproval: (d.run as { state: string }).state === "waiting_approval" } : {}),
          }));
          break;
        case "status":
          updateSessionState(sourceSessionId, (state) => ({
            ...state,
            streamingStatus: typeof d.message === "string" ? d.message : "正在处理",
          }));
          if (d.stage === "session_summary" && (d.state === "completed" || d.state === "failed")) {
            updateSessionState(sourceSessionId, (state) => ({
              ...state,
              summaryNotice: { state: d.state as "completed" | "failed", message: String(d.message ?? "") },
            }));
          }
          break;
        case "context_usage":
          updateSessionState(sourceSessionId, (state) => ({
            ...state,
            contextUsage: d.usage as unknown as ContextTokenUsage,
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
            startedAt: typeof d.startedAt === "number" ? d.startedAt : undefined,
            status: "running",
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
          if (tc) tc.completedAt = typeof d.completedAt === "number" ? d.completedAt : undefined;
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingToolCalls: [...toolCalls] }));
          if (name === "update_plan" || approvalId) await refreshSessionPlan(sourceSessionId);
          break;
        }
        case "done": {
          for (const toolCall of toolCalls) {
            if (toolCall.result === undefined) {
              toolCall.status = "unknown";
              toolCall.statusReason = "本轮已结束，未记录工具执行结果，请核实操作结果";
            }
          }
          const sid = (d.session_id as string) || sourceSessionId;
          backendApprovalRef.current.set(sid, d.reason === "approval_required");
          planRequestsRef.current.set(sourceSessionId, (planRequestsRef.current.get(sourceSessionId) ?? 0) + 1);
          if (d.reason !== "approval_required") {
            updateSessionState(sourceSessionId, (state) => ({ ...state, plan: null, planExecutionTurnId: undefined }));
          }
          const completedText = typeof d.text === "string" ? d.text : fullText;
          const plans = await fetchSessionPlans(sid).catch(() => []);
          const completedPlan = turnId ? plans.find((item) => item.turnId === turnId || item.relatedTurnIds?.includes(turnId!)) : undefined;
          const assistantMessage = { role: "assistant" as const, text: completedText, toolCalls: [...toolCalls], timestamp: Date.now(), turnId, plan: completedPlan, run: currentRun, runState: currentRun?.state };
          setSessionStates((previous) => {
            const source = previous[sourceSessionId] ?? emptySessionState();
            const target = previous[sid] ?? emptySessionState();
            const baseMessages = sid === sourceSessionId || target.loaded ? target.messages : source.messages;
            const next = {
              ...previous,
              [sid]: {
                ...target,
                latestPlans: plans,
                messages: d.clear_messages === true
                  ? [assistantMessage]
                  : approvalId
                    ? mergeApprovalResume(baseMessages, approvalId, completedText, toolCalls, { turnId, plan: completedPlan, run: currentRun, runState: currentRun?.state })
                    : [...baseMessages.filter((message) => !(turnId && message.role === "assistant" && message.turnId === turnId)), assistantMessage],
                streamingText: "",
                streamingStatus: "",
                streamingToolCalls: [],
                streamingApprovalId: undefined,
                backendBusy: false,
                awaitingApproval: d.reason === "approval_required",
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
                backendBusy: false,
                awaitingApproval: false,
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
        case "error": {
          planRequestsRef.current.set(sourceSessionId, (planRequestsRef.current.get(sourceSessionId) ?? 0) + 1);
          updateSessionState(sourceSessionId, (state) => ({ ...state, plan: null, planExecutionTurnId: undefined }));
          const plans = await fetchSessionPlans(sourceSessionId).catch(() => []);
          const plan = turnId ? plans.find((item) => item.turnId === turnId || item.relatedTurnIds?.includes(turnId!)) : undefined;
          updateSessionState(sourceSessionId, (state) => ({
            ...state,
            messages: [...state.messages, {
              role: "assistant",
              text: `Error: ${(d.message as string) ?? "未知错误"}`,
              toolCalls: [],
              timestamp: Date.now(),
              turnId,
              plan,
            }],
            streamingText: "",
            streamingStatus: "",
            streamingToolCalls: [],
            streamingApprovalId: undefined,
            backendBusy: false,
            awaitingApproval: false,
          }));
          await refreshSessionPlan(sourceSessionId);
          break;
        }
      }
    }
  }, [refreshSessionPlan, updateSessionState]);

  useEffect(() => {
    const sessionId = activeSessionId;
    if (!sessionId || !activeState.backendBusy || abortControllersRef.current.has(sessionId)) return;
    const controller = new AbortController();
    abortControllersRef.current.set(sessionId, controller);
    updateSessionState(sessionId, (state) => ({ ...state, isStreaming: true }));
    void (async () => {
      try {
        await consumeAgentStream(sessionId, streamSessionEvents(sessionId, controller.signal));
        if (!controller.signal.aborted) {
          const messages = await fetchHistoryMessages(sessionId);
          updateSessionState(sessionId, (state) => ({ ...state, messages, loaded: true }));
          await refreshSessionPlan(sessionId);
        }
      } catch {
        // The session poll retries a disconnected subscription without starting a new task.
      } finally {
        if (abortControllersRef.current.get(sessionId) === controller) {
          abortControllersRef.current.delete(sessionId);
          updateSessionState(sessionId, (state) => ({ ...state, isStreaming: false,
            ...(!state.backendBusy ? { streamingText: "", streamingToolCalls: [], streamingTurnId: undefined } : {}),
          }));
        }
      }
    })();
  }, [activeSessionId, activeState.backendBusy, reconnectKey, consumeAgentStream, refreshSessionPlan, updateSessionState]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 首次加载时恢复各视图最近使用的会话；URL 中的会话优先。
  useEffect(() => {
    const sid = readHashSession();
    fetchHistorySessions().then((sessions) => {
      handleSessionsLoaded(sessions);
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
  }, [handleSessionsLoaded, updateSessionState]);

  // activeSessionId 变化时同步到 URL hash
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
    writeHashSession(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSessionId) void refreshSessionPlan(activeSessionId);
  }, [activeSessionId, refreshSessionPlan]);

  const handleSend = useCallback(async (text: string, files: File[], planId?: string) => {
    if (activeBusy) return;
    if (planId) setExecutionMode("plan");
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
    planRequestsRef.current.set(sessionId, (planRequestsRef.current.get(sessionId) ?? 0) + 1);
    updateSessionState(sessionId, (state) => ({
      ...state,
      isStreaming: true,
      backendBusy: false,
      streamingText: "",
      streamingStatus: "",
      streamingToolCalls: [],
      streamingApprovalId: undefined,
      loaded: true,
      summaryNotice: undefined,
      plan: null,
      planExecutionTurnId: turnId,
      streamingTurnId: turnId,
      planLoaded: true,
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
        "normal",
        turnId,
        planId,
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
            backendBusy: false,
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
        backendBusy: false,
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
  }, [activeBusy, activeSessionId, consumeAgentStream, updateSessionState, projectRoot, view, executionMode]);

  const resumeApproval = useCallback(async (approvalId: string, action: "approve" | "approve-turn" | "reject") => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    abortControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    abortControllersRef.current.set(sessionId, controller);
    updateSessionState(sessionId, (state) => ({
      ...state,
      isStreaming: true,
      backendBusy: false,
      awaitingApproval: false,
      streamingText: "",
      streamingStatus: "",
      streamingToolCalls: [],
      streamingApprovalId: approvalId,
    }));
    try {
      await consumeAgentStream(sessionId, streamApprovalResume(approvalId, action, controller.signal), approvalId, activeState.planExecutionTurnId);
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
  }, [activeSessionId, activeState.planExecutionTurnId, consumeAgentStream, updateSessionState]);

  const handleApproveAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, "approve"),
    [resumeApproval],
  );

  const handleApproveTurnAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, "approve-turn"),
    [resumeApproval],
  );

  const handleRejectAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, "reject"),
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

  const handleStop = useCallback(async () => {
    if (!activeSessionId) return;
    planRequestsRef.current.set(activeSessionId, (planRequestsRef.current.get(activeSessionId) ?? 0) + 1);
    const id = activeSessionId;
    updateSessionState(id, (state) => ({ ...state, isStopping: true }));
    try {
      await cancelSession(id);
      if (activeState.awaitingApproval) {
        const messages = await fetchHistoryMessages(id);
        updateSessionState(id, (state) => ({ ...state, messages, awaitingApproval: false, isStreaming: false, backendBusy: false, plan: null }));
      }
      await refreshSessionPlan(id);
    } catch (error) {
      updateSessionState(id, (state) => ({ ...state, isStopping: false, summaryNotice: { state: "failed", message: `停止失败：${error instanceof Error ? error.message : String(error)}` } }));
    }
  }, [activeSessionId, activeState.awaitingApproval, refreshSessionPlan, updateSessionState]);

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
    updateSessionState(id, (state) => ({ ...state, backendBusy: session.busy === true }));
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

  const handlePermissionModeChange = useCallback(async (scope: "global" | "project", mode: PermissionMode) => {
    if (permissionSaving) return;
    const previous = scope === "project" ? projectPermissionMode : globalPermissionMode;
    if (previous === mode) return;
    if (scope === "project") setProjectPermissionMode(mode);
    else setGlobalPermissionMode(mode);
    setPermissionSaving(true);
    setPermissionError("");
    try {
      const config = await fetchConfig();
      const next = { ...config };
      if (scope === "project") {
        const project = { ...((config.project as Record<string, unknown> | undefined) ?? {}) };
        project.security = {
          ...((project.security as Record<string, unknown> | undefined) ?? {}),
          mode,
        };
        next.project = project;
      } else {
        next.security = {
          ...((config.security as Record<string, unknown> | undefined) ?? {}),
          mode,
        };
      }
      await updateConfig(next);
    } catch (error) {
      if (scope === "project") setProjectPermissionMode(previous);
      else setGlobalPermissionMode(previous);
      setPermissionError(error instanceof Error ? error.message : "保存权限配置失败");
    } finally {
      setPermissionSaving(false);
    }
  }, [globalPermissionMode, permissionSaving, projectPermissionMode]);

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
        onSessionsLoaded={handleSessionsLoaded}
        refreshKey={sidebarRefreshKey}
        projectRoot={projectRoot}
        theme={theme}
        onThemeChange={setTheme}
      />
      <div className="chat-area">
        {view === "chat" && (
          <>
            <ChatView
              messages={activeState.messages}
              activePlanId={activeState.plan?.id}
              activePlanTurnId={activeState.planExecutionTurnId}
              latestPlans={activeState.latestPlans}
              onResumePlan={activeBusy ? undefined : (id) => void handleSend("继续此计划", [], id)}
              streamingText={activeState.streamingText}
              streamingTurnId={activeState.streamingTurnId}
              streamingStatus={activeState.streamingStatus}
              streamingToolCalls={activeState.streamingToolCalls}
              streamingApprovalId={activeState.streamingApprovalId}
              isStreaming={activeState.isStreaming}
              backendBusy={activeState.backendBusy}
              activeSessionId={activeSessionId}
              summaryNotice={activeState.summaryNotice}
              isRefreshing={isRefreshingMessages}
              onRefreshMessages={handleRefreshMessages}
              onApproveAndResume={handleApproveAndResume}
              onApproveTurnAndResume={handleApproveTurnAndResume}
              onRejectAndResume={handleRejectAndResume}
            />
            <PlanProgress plan={activeState.plan} runState={activeState.run?.state} run={activeState.run} />
            <ChatInput
              onSend={handleSend}
              onStop={handleStop}
              isStopping={activeState.isStopping}
              disabled={activeBusy}
              executionMode={executionMode}
              onExecutionModeChange={handleExecutionModeChange}
              permissionMode={globalPermissionMode}
              onPermissionModeChange={(mode) => void handlePermissionModeChange("global", mode)}
              permissionSaving={permissionSaving}
              permissionError={permissionError}
              activeSessionId={activeSessionId}
              contextUsage={activeState.contextUsage}
            />
          </>
        )}
        {view === "project" && (
          <ProjectView
            summaryNotice={activeState.summaryNotice}
            latestPlans={activeState.latestPlans}
            runState={activeState.run?.state}
            run={activeState.run}
            awaitingApproval={activeState.awaitingApproval}
            activePlanTurnId={activeState.planExecutionTurnId}
            onResumePlan={activeBusy ? undefined : (id) => void handleSend("继续此计划", [], id)}
            messages={activeState.messages}
            streamingText={activeState.streamingText}
            streamingTurnId={activeState.streamingTurnId}
            streamingStatus={activeState.streamingStatus}
            streamingToolCalls={activeState.streamingToolCalls}
            streamingApprovalId={activeState.streamingApprovalId}
            isStreaming={activeState.isStreaming}
            backendBusy={activeState.backendBusy}
            activeSessionId={activeSessionId}
            isRefreshing={isRefreshingMessages}
            onRefreshMessages={handleRefreshMessages}
            onSend={handleSend}
            onStop={handleStop}
            isStopping={activeState.isStopping}
            onApproveAndResume={handleApproveAndResume}
            onApproveTurnAndResume={handleApproveTurnAndResume}
            onRejectAndResume={handleRejectAndResume}
            projectRoot={projectRoot}
            statusRefreshKey={projectStatusRefreshKey}
            onProjectChange={handleProjectChange}
            plan={activeState.plan}
            executionMode={executionMode}
            onExecutionModeChange={handleExecutionModeChange}
            permissionMode={projectPermissionMode}
            onPermissionModeChange={(mode) => void handlePermissionModeChange("project", mode)}
            permissionSaving={permissionSaving}
            permissionError={permissionError}
            contextUsage={activeState.contextUsage}
          />
        )}
        {view === "memory" && <MemoryManager />}
        {view === "logs" && <LogViewer />}
        {view === "plugins" && <PluginManagerView />}
        {view === "config" && <ConfigEditor />}
      </div>
    </div>
  );
}
