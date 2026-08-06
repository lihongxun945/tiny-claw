import { Fragment, useEffect, useRef } from "react";
import type { Message, ToolCallInfo } from "../types.js";
import MessageBubble from "./MessageBubble.js";
import PlanProgress from "./PlanProgress.js";
import { mergeApprovalResume } from "../lib/message-merge.js";

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
  onApproveAndResume: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume: (approvalId: string) => Promise<void>;
}

export default function ChatView({
  messages,
  streamingText,
  streamingStatus,
  streamingToolCalls,
  streamingApprovalId,
  isStreaming,
  activeSessionId,
  isRefreshing,
  onRefreshMessages,
  onApproveAndResume,
  onApproveTurnAndResume,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const displayedMessages = streamingApprovalId
    ? mergeApprovalResume(messages, streamingApprovalId, streamingText, streamingToolCalls)
    : messages;

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
        {displayedMessages.length === 0 && !isStreaming && (
          <div className="chat-empty-state">
            <img className="empty-mark" src="/icon.png" alt="" aria-hidden="true" />
            <h1>开始一段新对话</h1>
            <p>描述你想完成的任务，tiny-claw 会调用合适的工具并持续执行。</p>
          </div>
        )}
        {displayedMessages.map((msg, i) => (
          <Fragment key={`${msg.turnId ?? "message"}-${i}`}>
            <MessageBubble
              message={msg}
              onApproveAndResume={onApproveAndResume}
              onApproveTurnAndResume={onApproveTurnAndResume}
            />
            {msg.role === "assistant" && msg.plan && <PlanProgress plan={msg.plan} />}
          </Fragment>
        ))}
        {isStreaming && !streamingApprovalId && (
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
              onApproveTurnAndResume={onApproveTurnAndResume}
            />
          ) : (
            <div className="message assistant">
              <div className="message-content processing-indicator" aria-live="polite">
                <span>{streamingStatus || "正在处理"}</span>
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
