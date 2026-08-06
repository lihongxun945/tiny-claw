import { useState } from "react";
import Markdown from "react-markdown";
import type { ToolCallInfo } from "../types.js";
import { approveCommand, rejectCommand } from "../lib/api.js";

interface Props {
  toolCall: ToolCallInfo;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume?: (approvalId: string) => Promise<void>;
}

export interface ApprovalResult {
  requiresConfirmation: true;
  approvalId: string;
  command?: string;
  cwd?: string;
  error?: string;
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (name === "web_search" && input.query) return String(input.query);
  if (name === "web_fetch" && input.url) return String(input.url);
  if (name === "bash" && input.command) return String(input.command);
  if (name === "file_read" && input.path) return String(input.path);
  if (name === "file_write" && input.path) return String(input.path);
  if (name === "file_edit" && input.path) return String(input.path);
  if (name === "memory_save" && input.name) return String(input.name);
  if (name === "skill_use" && input.name) return String(input.name);
  const vals = Object.values(input);
  if (vals.length === 1) return String(vals[0]).slice(0, 80);
  return JSON.stringify(input).slice(0, 80);
}

function summarizeResult(result: string | undefined): string {
  if (!result) return "";
  try {
    const obj = JSON.parse(result);
    if (obj.requiresConfirmation && obj.approvalId) return "需要批准";
    if (obj.error) return `❌ ${obj.error}`;
    if (obj.stdout !== undefined) return obj.stdout.slice(0, 80);
    if (obj.results) return `${Array.isArray(obj.results) ? obj.results.length : 0} 条结果`;
    if (obj.content) return obj.content.slice(0, 80);
  } catch { /* not JSON */ }
  return result.slice(0, 80);
}

export function parseApprovalResult(result: string | undefined): ApprovalResult | undefined {
  if (!result) return undefined;
  try {
    const obj = JSON.parse(result) as Partial<ApprovalResult>;
    if (obj.requiresConfirmation === true && typeof obj.approvalId === "string") {
      return obj as ApprovalResult;
    }
  } catch { /* not JSON */ }
  return undefined;
}

export function isToolCallFailure(result: string | undefined): boolean {
  if (!result) return false;
  try {
    const value = JSON.parse(result) as { error?: unknown; requiresConfirmation?: unknown };
    return typeof value.error === "string" && value.requiresConfirmation !== true;
  } catch {
    return false;
  }
}

export default function ToolCallBlock({ toolCall, onApproveAndResume, onApproveTurnAndResume }: Props) {
  const approval = parseApprovalResult(toolCall.result);
  const [approvalStatus, setApprovalStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [approvalMessage, setApprovalMessage] = useState("");
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const inputStr = JSON.stringify(toolCall.input, null, 2);
  const inputSummary = summarizeInput(toolCall.name, toolCall.input);
  const resultSummary = summarizeResult(toolCall.result);

  const handleApprove = async () => {
    if (!approval) return;
    setIsSubmittingApproval(true);
    setApprovalMessage("");
    try {
      if (onApproveAndResume) {
        setApprovalMessage("已批准，正在继续执行...");
        await onApproveAndResume(approval.approvalId);
      } else {
        await approveCommand(approval.approvalId);
      }
      setApprovalStatus("approved");
      setApprovalMessage("已批准，并已继续执行原任务。");
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : "批准失败");
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  const handleReject = async () => {
    if (!approval) return;
    setIsSubmittingApproval(true);
    setApprovalMessage("");
    try {
      await rejectCommand(approval.approvalId);
      setApprovalStatus("rejected");
      setApprovalMessage("已拒绝。");
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : "拒绝失败");
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  const handleApproveTurn = async () => {
    if (!approval || !onApproveTurnAndResume) return;
    setIsSubmittingApproval(true);
    setApprovalMessage("已允许本轮，正在继续执行...");
    try {
      await onApproveTurnAndResume(approval.approvalId);
      setApprovalStatus("approved");
      setApprovalMessage("本轮后续权限申请已自动允许，任务已继续执行。");
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : "允许本轮失败");
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  return (
    <details className="tool-block" open={approval ? true : undefined}>
      <summary>
        <span className="tool-name">{toolCall.name}</span>
        {inputSummary && <span className="tool-input-summary">{inputSummary}</span>}
        {resultSummary && <span className="tool-result-summary">{resultSummary}</span>}
      </summary>
      <div className={`tool-body ${approval ? "tool-body-approval" : ""}`}>
        {approval ? (
          <div className="tool-approval">
            <div className="tool-approval-content">
              <div><strong>Input:</strong></div>
              <div>{inputStr}</div>
              <div style={{ marginTop: 8 }}><strong>Result:</strong></div>
              <div>
                <div className="tool-approval-title">此工具调用需要批准</div>
                {approval.error && <div>{approval.error}</div>}
                <div>审批 ID：<code>{approval.approvalId}</code></div>
                {approval.command && <pre>{approval.command}</pre>}
                {approval.cwd && <div>目录：{approval.cwd}</div>}
                <div className="tool-approval-hint">“允许本轮”仅对当前用户消息的后续权限申请生效，不会修改权限配置。</div>
              </div>
            </div>
            <div className="tool-approval-footer">
                <div className="tool-approval-actions">
                  <button onClick={handleApprove} disabled={isSubmittingApproval || approvalStatus !== "pending"}>
                    {approvalStatus === "approved" ? "已批准" : "批准本次"}
                  </button>
                  {onApproveTurnAndResume && (
                    <button className="approve-turn" onClick={handleApproveTurn} disabled={isSubmittingApproval || approvalStatus !== "pending"}>
                      允许本轮
                    </button>
                  )}
                  <button onClick={handleReject} disabled={isSubmittingApproval || approvalStatus !== "pending"}>拒绝</button>
                </div>
                {approvalMessage && <div className="tool-approval-message">{approvalMessage}</div>}
            </div>
          </div>
        ) : (
          <>
            <div><strong>Input:</strong></div>
            <div>{inputStr}</div>
            {toolCall.result !== undefined && (
              <>
                <div style={{ marginTop: 8 }}><strong>Result:</strong></div>
              <Markdown>{toolCall.result}</Markdown>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}
