import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { Message, ToolCallInfo, SessionPlan, RunView } from "../types.js";
import { formatDuration, useElapsedTime } from "../lib/elapsed-time.js";
import MessageBubble from "./MessageBubble.js";
import PlanProgress from "./PlanProgress.js";
import { mergeApprovalResume } from "../lib/message-merge.js";

interface Props {
  run?: RunView;
  isStopping?: boolean;
  connectionLost?: boolean;
  awaitingApproval?: boolean;
  messages: Message[];
  activePlanId?: string;
  activePlanTurnId?: string;
  onResumePlan?: (planId: string) => void;
  latestPlans?: SessionPlan[];
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
  onRejectAndResume: (approvalId: string) => Promise<void>;
}

export default function ChatView({
  run,
  isStopping,
  connectionLost,
  awaitingApproval,
  messages,
  activePlanId,
  activePlanTurnId,
  onResumePlan,
  latestPlans,
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
  onRejectAndResume,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const previousScrollRef = useRef<{ sessionId: string | null; hasMessages: boolean } | undefined>(undefined);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});
  const displayedMessages = streamingApprovalId
    ? mergeApprovalResume(messages, streamingApprovalId, streamingText, streamingToolCalls, { turnId: streamingTurnId })
    : messages.filter((message) => !((isStreaming || backendBusy) && streamingTurnId && message.role === "assistant" && message.turnId === streamingTurnId));
  const showBackendBusy = backendBusy && !isStreaming;
  const activity = !streamingTurnId || run?.turnId === streamingTurnId ? run?.status : undefined;
  const waitingInput = run?.state === "waiting_user" && run.suspension?.status === "pending";
  const active = (isStreaming || backendBusy) && !waitingInput;
  const statusText = isStopping ? "正在停止任务..."
    : awaitingApproval ? "等待您的审批，操作尚未执行"
    : connectionLost ? "连接已断开，正在重连；任务状态待确认"
    : activity?.state === "started" ? activity.message
    : streamingStatus || (streamingText ? "正在生成回答..." : "正在处理");
  const elapsed = useElapsedTime(activity?.startedAt, undefined, active && !connectionLost && !awaitingApproval);
  const textStreaming = active && !isStopping && !connectionLost && !awaitingApproval
    && (activity ? activity.stage === "execution:model_output" : !streamingStatus);
  const lastPlanMessage = new Map<string, number>();
  displayedMessages.forEach((message, index) => {
    if (message.role === "assistant" && message.plan) lastPlanMessage.set(`${message.turnId ?? message.plan.turnId}:${message.plan.id}`, index);
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

  useLayoutEffect(() => {
    const previous = previousScrollRef.current;
    const switchingSession = !previous || previous.sessionId !== activeSessionId;
    const loadingHistory = !previous?.hasMessages && messages.length > 0;
    bottomRef.current?.scrollIntoView({ behavior: switchingSession || loadingHistory ? "instant" : "smooth" });
    previousScrollRef.current = { sessionId: activeSessionId, hasMessages: messages.length > 0 };
  }, [activeSessionId, messages, streamingText, streamingToolCalls, streamingStatus]);

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
            <p>描述你想完成的任务，Breeze Coder 会调用合适的工具并持续执行。</p>
          </div>
        )}
        {displayedMessages.map((msg, i) => (
          <Fragment key={`${msg.turnId ?? "message"}-${i}`}>
            <MessageBubble
              message={msg}
              {...toolGroupProps(msg)}
              onApproveAndResume={onApproveAndResume}
              onApproveTurnAndResume={onApproveTurnAndResume}
              onRejectAndResume={onRejectAndResume}
            />
            {msg.role === "assistant" && msg.plan && !(msg.plan.id === activePlanId && msg.turnId === activePlanTurnId)
              && lastPlanMessage.get(`${msg.turnId ?? msg.plan.turnId}:${msg.plan.id}`) === i && <PlanProgress plan={msg.plan} historical runState={msg.runState} run={msg.run}
                onResume={onResumePlan && (latestPlans ?? [msg.plan]).some((plan) => plan.id === msg.plan!.id && plan.status !== "completed" && plan.status !== "failed") ? () => onResumePlan(msg.plan!.id) : undefined} />}
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
                  isStreaming={textStreaming}
                  onApproveAndResume={onApproveAndResume}
                  onApproveTurnAndResume={onApproveTurnAndResume}
                  onRejectAndResume={onRejectAndResume}
                />
              );
            })()
          ) : null
        )}
        {(active || awaitingApproval) && (
          <div className="execution-status processing-indicator" role="status" aria-live="polite">
            <span className="execution-status-text" title={statusText}>{statusText}</span>
            {elapsed !== undefined && !isStopping && <span className="execution-status-time" aria-live="off">已耗时 {formatDuration(elapsed)}</span>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}
