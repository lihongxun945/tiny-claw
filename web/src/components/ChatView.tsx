import { useEffect, useRef } from "react";
import type { Message, ToolCallInfo } from "../types.js";
import MessageBubble from "./MessageBubble.js";

interface Props {
  messages: Message[];
  streamingText: string;
  streamingToolCalls: ToolCallInfo[];
  isStreaming: boolean;
  activeSessionId: string | null;
  isRefreshing?: boolean;
  onRefreshMessages: () => void;
  onApproveAndResume: (approvalId: string) => Promise<void>;
}

export default function ChatView({
  messages,
  streamingText,
  streamingToolCalls,
  isStreaming,
  activeSessionId,
  isRefreshing,
  onRefreshMessages,
  onApproveAndResume,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, streamingToolCalls]);

  return (
    <>
      <div className="chat-toolbar">
        <div className="chat-title">
          <span className="chat-title-mark" aria-hidden="true">✎</span>
          <span>{activeSessionId ? `会话 ${activeSessionId.slice(0, 8)}` : "新对话"}</span>
        </div>
        <button
          onClick={onRefreshMessages}
          disabled={!activeSessionId || isStreaming || isRefreshing}
          title="刷新消息列表"
        >
          <span aria-hidden="true">↻</span> 刷新
        </button>
      </div>
      <div className="chat-view">
        {messages.length === 0 && !isStreaming && (
          <div className="chat-empty-state">
            <span className="empty-mark" aria-hidden="true">t</span>
            <h1>开始一段新对话</h1>
            <p>描述你想完成的任务，tiny-claw 会调用合适的工具并持续执行。</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} onApproveAndResume={onApproveAndResume} />
        ))}
        {isStreaming && (
          streamingText || streamingToolCalls.length > 0 ? (
            <MessageBubble
              message={{
                role: "assistant",
                text: streamingText,
                toolCalls: streamingToolCalls,
                timestamp: Date.now(),
              }}
              isStreaming
              onApproveAndResume={onApproveAndResume}
            />
          ) : (
            <div className="message assistant">
              <div className="message-content processing-indicator" aria-live="polite">
                <span>正在处理</span>
                <span className="processing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}
