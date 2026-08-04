import { useState, useCallback, useEffect, useRef } from "react";
import type { Attachment, Message, ToolCallInfo } from "./types.js";
import { streamChat, streamApprovalResume, fetchHistoryMessages, cancelSession, uploadImage } from "./lib/api.js";
import { mergeApprovalResume } from "./lib/message-merge.js";
import ChatView from "./components/ChatView.js";
import ChatInput from "./components/ChatInput.js";
import SessionSidebar from "./components/SessionSidebar.js";
import LogViewer from "./components/LogViewer.js";
import ConfigEditor from "./components/ConfigEditor.js";
import MemoryManager from "./components/MemoryManager.js";

type View = "chat" | "memory" | "logs" | "config";

interface SessionUiState {
  messages: Message[];
  streamingText: string;
  streamingToolCalls: ToolCallInfo[];
  streamingApprovalId?: string;
  isStreaming: boolean;
  loaded: boolean;
}

function emptySessionState(): SessionUiState {
  return {
    messages: [],
    streamingText: "",
    streamingToolCalls: [],
    streamingApprovalId: undefined,
    isStreaming: false,
    loaded: false,
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
  const [sessionStates, setSessionStates] = useState<Record<string, SessionUiState>>({});
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(readHashSession);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const activeSessionRef = useRef<string | null>(activeSessionId);
  const abortControllersRef = useRef(new Map<string, AbortController>());

  const activeState = activeSessionId ? sessionStates[activeSessionId] ?? emptySessionState() : emptySessionState();

  const updateSessionState = useCallback((sessionId: string, update: (state: SessionUiState) => SessionUiState) => {
    setSessionStates((previous) => ({
      ...previous,
      [sessionId]: update(previous[sessionId] ?? emptySessionState()),
    }));
  }, []);

  const consumeAgentStream = useCallback(async (
    sourceSessionId: string,
    events: AsyncIterable<{ event: string; data: unknown }>,
    approvalId?: string,
  ) => {
    let fullText = "";
    const toolCalls: ToolCallInfo[] = [];

    for await (const event of events) {
      const d = event.data as Record<string, unknown>;
      switch (event.event) {
        case "text_delta":
          fullText += (d.text as string) ?? "";
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingText: fullText }));
          break;
        case "tool_call":
          toolCalls.push({
            id: typeof d.tool_call_id === "string" ? d.tool_call_id : undefined,
            name: (d.name as string) ?? "",
            input: (d.input as Record<string, unknown>) ?? {},
          });
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingToolCalls: [...toolCalls] }));
          break;
        case "tool_result": {
          const toolCallId = typeof d.tool_call_id === "string" ? d.tool_call_id : undefined;
          const name = (d.name as string) ?? "";
          const tc = toolCalls.find((t) => (
            t.result === undefined && (toolCallId ? t.id === toolCallId : t.name === name)
          ));
          if (tc) tc.result = (d.result as string) ?? "";
          updateSessionState(sourceSessionId, (state) => ({ ...state, streamingToolCalls: [...toolCalls] }));
          break;
        }
        case "done": {
          const sid = (d.session_id as string) || sourceSessionId;
          const completedText = typeof d.text === "string" ? d.text : fullText;
          const assistantMessage = { role: "assistant" as const, text: completedText, toolCalls: [...toolCalls], timestamp: Date.now() };
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
                    ? mergeApprovalResume(baseMessages, approvalId, completedText, toolCalls)
                    : [...baseMessages, assistantMessage],
                streamingText: "",
                streamingToolCalls: [],
                streamingApprovalId: undefined,
                loaded: true,
              },
            };
            if (sid !== sourceSessionId) {
              next[sourceSessionId] = {
                ...source,
                streamingText: "",
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
          setSidebarRefreshKey((k) => k + 1);
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
            streamingToolCalls: [],
            streamingApprovalId: undefined,
          }));
          break;
      }
    }
  }, [updateSessionState]);

  // 首次加载时，从 URL hash 恢复会话消息
  useEffect(() => {
    const sid = readHashSession();
    if (!sid) return;
    fetchHistoryMessages(sid)
      .then((msgs) => updateSessionState(sid, (state) => ({ ...state, messages: msgs, loaded: true })))
      .catch(() => {});
  }, [updateSessionState]);

  // activeSessionId 变化时同步到 URL hash
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
    writeHashSession(activeSessionId);
  }, [activeSessionId]);

  const handleSend = useCallback(async (text: string, files: File[]) => {
    const sessionId = activeSessionId ?? crypto.randomUUID();
    abortControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    abortControllersRef.current.set(sessionId, controller);
    updateSessionState(sessionId, (state) => ({
      ...state,
      isStreaming: true,
      streamingText: "",
      streamingToolCalls: [],
      streamingApprovalId: undefined,
      loaded: true,
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
        messages: [...state.messages, { role: "user", text, toolCalls: [], attachments, timestamp: Date.now() }],
      }));
      await consumeAgentStream(sessionId, streamChat(
        text,
        sessionId,
        attachments.map((attachment) => attachment.id),
        controller.signal,
      ));
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
        streamingApprovalId: undefined,
      }));
    }
  }, [activeSessionId, consumeAgentStream, updateSessionState]);

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
      streamingToolCalls: [],
      streamingApprovalId: approvalId,
    }));
    try {
      await consumeAgentStream(sessionId, streamApprovalResume(approvalId, allowTurn, controller.signal), approvalId);
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
        streamingApprovalId: undefined,
      }));
    }
  }, [activeSessionId, consumeAgentStream, updateSessionState]);

  const handleApproveAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, false),
    [resumeApproval],
  );

  const handleApproveTurnAndResume = useCallback(
    (approvalId: string) => resumeApproval(approvalId, true),
    [resumeApproval],
  );

  const handleNewChat = useCallback(() => {
    setView("chat");
    activeSessionRef.current = null;
    setActiveSessionId(null);
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

  const handleSelectSession = useCallback(async (id: string) => {
    activeSessionRef.current = id;
    setActiveSessionId(id);
    if (sessionStates[id]?.loaded) return;
    try {
      const msgs = await fetchHistoryMessages(id);
      updateSessionState(id, (state) => ({ ...state, messages: msgs, loaded: true }));
    } catch {
      updateSessionState(id, (state) => ({ ...state, messages: [], loaded: true }));
    }
  }, [sessionStates, updateSessionState]);

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
  }, [activeSessionId]);

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
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onSessionDeleted={handleSessionDeleted}
        onViewChange={setView}
        refreshKey={sidebarRefreshKey}
      />
      <div className="chat-area">
        {view === "chat" && (
          <>
            <ChatView
              messages={activeState.messages}
              streamingText={activeState.streamingText}
              streamingToolCalls={activeState.streamingToolCalls}
              streamingApprovalId={activeState.streamingApprovalId}
              isStreaming={activeState.isStreaming}
              activeSessionId={activeSessionId}
              isRefreshing={isRefreshingMessages}
              onRefreshMessages={handleRefreshMessages}
              onApproveAndResume={handleApproveAndResume}
              onApproveTurnAndResume={handleApproveTurnAndResume}
            />
            <ChatInput onSend={handleSend} onStop={handleStop} disabled={activeState.isStreaming} />
          </>
        )}
        {view === "memory" && <MemoryManager />}
        {view === "logs" && <LogViewer />}
        {view === "config" && <ConfigEditor />}
      </div>
    </div>
  );
}
