import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolCallInfo } from "../types.js";
import ToolCallBlock, { isToolCallFailure, parseApprovalResult } from "./ToolCallBlock.js";

interface Props {
  toolCalls: ToolCallInfo[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume?: (approvalId: string) => Promise<void>;
}

export default function ToolCallGroup({ toolCalls, expanded: controlledExpanded, onExpandedChange, onApproveAndResume, onApproveTurnAndResume }: Props) {
  const stats = useMemo(() => {
    const pending = toolCalls.filter((toolCall) => parseApprovalResult(toolCall.result)).length;
    const running = toolCalls.filter((toolCall) => toolCall.result === undefined).length;
    const failed = toolCalls.filter((toolCall) => isToolCallFailure(toolCall.result)).length;
    return { pending, running, failed, completed: toolCalls.length - pending - running - failed };
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
            />
          ))}
        </div>
      )}
    </section>
  );
}
