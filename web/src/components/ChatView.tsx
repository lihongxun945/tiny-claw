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
        <span>{activeSessionId ? `会话 ${activeSessionId.slice(0, 8)}` : "新对话"}</span>
        <button
          onClick={onRefreshMessages}
          disabled={!activeSessionId || isStreaming || isRefreshing}
          title="刷新消息列表"
        >
          刷新
        </button>
      </div>
      <div className="chat-view">
        {messages.length === 0 && !isStreaming && (
          <div className="empty-state">发送一条消息开始对话</div>
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
