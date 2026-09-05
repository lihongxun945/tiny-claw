import { Fragment, useEffect, useRef, useState } from "react";
import type { Message, ToolCallInfo } from "../types.js";
import MessageBubble from "./MessageBubble.js";
import PlanProgress from "./PlanProgress.js";
import { mergeApprovalResume } from "../lib/message-merge.js";

interface Props {
  messages: Message[];
  activePlanId?: string;
  streamingText: string;
  streamingTurnId?: string;
  streamingStatus: string;
  streamingToolCalls: ToolCallInfo[];
  summaryNotice?: { state: "completed" | "failed"; message: string };
  streamingApprovalId?: string;
  isStreaming: boolean;
  backendBusy?: boolean;
  activeSessionId: string | null;
  isRefreshing?: boolean;
  onRefreshMessages: () => void;
  onApproveAndResume: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume: (approvalId: string) => Promise<void>;
}

export default function ChatView({
  messages,
  activePlanId,
  streamingText,
  streamingTurnId,
  streamingStatus,
  streamingToolCalls,
  summaryNotice,
  streamingApprovalId,
  isStreaming,
  backendBusy = false,
  activeSessionId,
  isRefreshing,
  onRefreshMessages,
  onApproveAndResume,
  onApproveTurnAndResume,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});
  const displayedMessages = streamingApprovalId
    ? mergeApprovalResume(messages, streamingApprovalId, streamingText, streamingToolCalls)
    : messages.filter((message) => !(isStreaming && streamingTurnId && message.role === "assistant" && message.turnId === streamingTurnId));
  const showBackendBusy = backendBusy && !isStreaming;
  const lastPlanMessage = new Map<string, number>();
  displayedMessages.forEach((message, index) => {
    if (message.role === "assistant" && message.plan) lastPlanMessage.set(message.plan.id, index);
  });

  const toolGroupProps = (message: Message) => {
    if (message.toolCalls.length <= 1) return {};
    const key = message.toolCalls[0].id ?? `${message.turnId ?? message.timestamp}:tools`;
    return {
      toolGroupExpanded: expandedToolGroups[key],
      onToolGroupExpandedChange: (expanded: boolean) => {
        setExpandedToolGroups((previous) => ({ ...previous, [key]: expanded }));
      },
    };
  };

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
        {summaryNotice && (
          <div className={`summary-lifecycle-notice summary-${summaryNotice.state}`} role="status">
            <span aria-hidden="true">{summaryNotice.state === "completed" ? "✓" : "!"}</span>
            <span>{summaryNotice.message}</span>
          </div>
        )}
        {displayedMessages.length === 0 && !isStreaming && !showBackendBusy && (
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
              {...toolGroupProps(msg)}
              onApproveAndResume={onApproveAndResume}
              onApproveTurnAndResume={onApproveTurnAndResume}
            />
            {msg.role === "assistant" && msg.plan && msg.plan.id !== activePlanId
              && lastPlanMessage.get(msg.plan.id) === i && <PlanProgress plan={msg.plan} historical />}
          </Fragment>
        ))}
        {(isStreaming || showBackendBusy) && !streamingApprovalId && (
          streamingText || streamingToolCalls.length > 0 ? (
            (() => {
              const message: Message = {
                role: "assistant",
                text: streamingText,
                toolCalls: streamingToolCalls,
                timestamp: Date.now(),
              };
              return (
                <MessageBubble
                  message={message}
                  {...toolGroupProps(message)}
                  isStreaming
                  onApproveAndResume={onApproveAndResume}
                  onApproveTurnAndResume={onApproveTurnAndResume}
                />
              );
            })()
          ) : (
            <div className="message assistant">
              <div className="message-content processing-indicator" aria-live="polite">
                <span>{showBackendBusy ? "正在后台执行" : streamingStatus || "正在处理"}</span>
                <span className="processing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="streaming-cursor" aria-hidden="true" />
              </div>
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}
