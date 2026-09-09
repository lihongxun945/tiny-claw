import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolCallInfo } from "../types.js";
import ToolCallBlock, { isToolCallRunning, isToolCallBlocked, isToolCallFailure, parseApprovalResult } from "./ToolCallBlock.js";

interface Props {
  toolCalls: ToolCallInfo[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume?: (approvalId: string) => Promise<void>;
  onRejectAndResume?: (approvalId: string) => Promise<void>;
}

export default function ToolCallGroup({ toolCalls, expanded: controlledExpanded, onExpandedChange, onApproveAndResume, onApproveTurnAndResume, onRejectAndResume }: Props) {
  const stats = useMemo(() => {
    const pending = toolCalls.filter((toolCall) => parseApprovalResult(toolCall.result)).length;
    const running = toolCalls.filter(isToolCallRunning).length;
    const interrupted = toolCalls.filter((toolCall) => toolCall.result === undefined && !isToolCallRunning(toolCall) && toolCall.status === "interrupted").length;
    const unknown = toolCalls.filter((toolCall) => toolCall.result === undefined && !isToolCallRunning(toolCall) && toolCall.status !== "interrupted").length;
    const failed = toolCalls.filter((toolCall) => isToolCallFailure(toolCall.result)).length;
    const blocked = toolCalls.filter((toolCall) => isToolCallBlocked(toolCall.result)).length;
    return { pending, running, failed, blocked, interrupted, unknown, completed: toolCalls.length - pending - running - failed - blocked - interrupted - unknown };
  }, [toolCalls]);
  const mustExpand = stats.pending > 0;
  const [automaticExpanded, setAutomaticExpanded] = useState(mustExpand || stats.running > 0);
  const wasActiveRef = useRef(mustExpand || stats.running > 0);
  const expanded = mustExpand || (controlledExpanded ?? automaticExpanded);

  useEffect(() => {
    const isActive = mustExpand || stats.running > 0;
    if (mustExpand) setAutomaticExpanded(true);
    else if (wasActiveRef.current && !isActive) setAutomaticExpanded(false);
    wasActiveRef.current = isActive;
  }, [mustExpand, stats.running]);

  const summary = [
    `${toolCalls.length} 次调用`,
    stats.running > 0 ? `${stats.running} 执行中` : "",
    stats.pending > 0 ? `${stats.pending} 待审批` : "",
    stats.completed > 0 ? `${stats.completed} 成功` : "",
    stats.failed > 0 ? `${stats.failed} 失败` : "",
    stats.blocked > 0 ? `${stats.blocked} 已拦截` : "",
    stats.interrupted > 0 ? `${stats.interrupted} 已中断` : "",
    stats.unknown > 0 ? `${stats.unknown} 结果未知` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className={`tool-call-group ${mustExpand ? "has-approval" : ""}`}>
      <button
        type="button"
        className="tool-call-group-header"
        aria-expanded={expanded}
        onClick={() => {
          if (mustExpand) return;
          const nextExpanded = !expanded;
          setAutomaticExpanded(nextExpanded);
          onExpandedChange?.(nextExpanded);
        }}
      >
        <span className="tool-call-group-title">工具调用</span>
        {stats.running > 0 && <span className="tool-running-spinner" aria-hidden="true" />}
        <span className="tool-call-group-summary">{summary}</span>
        <span className="tool-call-group-chevron" aria-hidden="true">⌄</span>
      </button>
      {expanded && (
        <div className="tool-call-group-list">
          {toolCalls.map((toolCall, index) => (
            <ToolCallBlock
              key={toolCall.id ?? `${toolCall.name}-${index}`}
              toolCall={toolCall}
              onApproveAndResume={onApproveAndResume}
              onApproveTurnAndResume={onApproveTurnAndResume}
              onRejectAndResume={onRejectAndResume}
            />
          ))}
        </div>
      )}
    </section>
  );
}
