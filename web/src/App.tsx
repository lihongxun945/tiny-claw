import { useState, useCallback, useEffect, useRef } from "react";
import type { Message, ToolCallInfo } from "./types.js";
import { streamChat, fetchHistoryMessages } from "./lib/api.js";
import ChatView from "./components/ChatView.js";
import ChatInput from "./components/ChatInput.js";
import SessionSidebar from "./components/SessionSidebar.js";
import LogViewer from "./components/LogViewer.js";
import ConfigEditor from "./components/ConfigEditor.js";
import MemoryManager from "./components/MemoryManager.js";

type View = "chat" | "memory" | "logs" | "config";

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

export default function App() {
  const [view, setView] = useState<View>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallInfo[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(readHashSession);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // 首次加载时，从 URL hash 恢复会话消息
  useEffect(() => {
    const sid = readHashSession();
    if (!sid) return;
    fetchHistoryMessages(sid)
      .then((msgs) => { if (msgs.length > 0) setMessages(msgs); })
      .catch(() => {});
  }, []);

  // activeSessionId 变化时同步到 URL hash
  useEffect(() => {
    writeHashSession(activeSessionId);
  }, [activeSessionId]);

  const handleSend = useCallback(async (text: string) => {
    // 取消之前的流
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [...prev, { role: "user", text, toolCalls: [], timestamp: Date.now() }]);
    setIsStreaming(true);
    setStreamingText("");
    setStreamingToolCalls([]);

    try {
      let fullText = "";
      const toolCalls: ToolCallInfo[] = [];

      for await (const event of streamChat(text, activeSessionId ?? undefined, controller.signal)) {
        const d = event.data as Record<string, unknown>;
        switch (event.event) {
          case "text_delta":
            fullText += (d.text as string) ?? "";
            setStreamingText(fullText);
            break;
          case "tool_call":
            toolCalls.push({
              name: (d.name as string) ?? "",
              input: (d.input as Record<string, unknown>) ?? {},
            });
            setStreamingToolCalls([...toolCalls]);
            break;
          case "tool_result": {
            const name = (d.name as string) ?? "";
            const tc = toolCalls.find((t) => t.name === name && t.result === undefined);
            if (tc) tc.result = (d.result as string) ?? "";
            setStreamingToolCalls([...toolCalls]);
            break;
          }
          case "done": {
            const sid = (d.session_id as string) ?? null;
            if (sid) setActiveSessionId(sid);
            setMessages((prev) => [
              ...prev,
              { role: "assistant", text: fullText, toolCalls: [...toolCalls], timestamp: Date.now() },
            ]);
            setStreamingText("");
            setStreamingToolCalls([]);
            setSidebarRefreshKey((k) => k + 1);
            break;
          }
          case "error":
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                text: `Error: ${(d.message as string) ?? "未知错误"}`,
                toolCalls: [],
                timestamp: Date.now(),
              },
            ]);
            setStreamingText("");
            setStreamingToolCalls([]);
            break;
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `连接失败: ${msg}`, toolCalls: [], timestamp: Date.now() },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }, [activeSessionId]);

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setView("chat");
    setActiveSessionId(null);
    setMessages([]);
    setStreamingText("");
    setStreamingToolCalls([]);
    setIsStreaming(false);
  }, []);

  const handleSelectSession = useCallback(async (id: string) => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setActiveSessionId(id);
    setStreamingText("");
    setStreamingToolCalls([]);
    try {
      const msgs = await fetchHistoryMessages(id);
      setMessages(msgs);
    } catch {
      setMessages([]);
    }
  }, []);

  const handleSessionDeleted = useCallback((id: string) => {
    if (activeSessionId === id) {
      setActiveSessionId(null);
      setMessages([]);
    }
  }, [activeSessionId]);

  const handleRefreshMessages = useCallback(async () => {
    if (!activeSessionId || isStreaming || isRefreshingMessages) return;
    setIsRefreshingMessages(true);
    try {
      const msgs = await fetchHistoryMessages(activeSessionId);
      setMessages(msgs);
    } catch {
      // ignore
    } finally {
      setIsRefreshingMessages(false);
    }
  }, [activeSessionId, isRefreshingMessages, isStreaming]);

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
              messages={messages}
              streamingText={streamingText}
              streamingToolCalls={streamingToolCalls}
              isStreaming={isStreaming}
              activeSessionId={activeSessionId}
              isRefreshing={isRefreshingMessages}
              onRefreshMessages={handleRefreshMessages}
            />
            <ChatInput onSend={handleSend} disabled={isStreaming} />
          </>
        )}
        {view === "memory" && <MemoryManager />}
        {view === "logs" && <LogViewer />}
        {view === "config" && <ConfigEditor />}
      </div>
    </div>
  );
}
