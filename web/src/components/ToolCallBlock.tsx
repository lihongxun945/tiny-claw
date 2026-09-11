import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { ToolCallInfo } from "../types.js";
import { approveCommand, rejectCommand, renewCommand } from "../lib/api.js";
import { formatDuration, useElapsedTime } from "../lib/elapsed-time.js";

interface Props {
  toolCall: ToolCallInfo;
  onApproveAndResume?: (approvalId: string) => Promise<void>;
  onApproveTurnAndResume?: (approvalId: string) => Promise<void>;
  onRejectAndResume?: (approvalId: string) => Promise<void>;
}

export interface ApprovalResult {
  requiresConfirmation: true;
  approvalId: string;
  approvalStatus?: "pending" | "approved" | "expired";
  expiresAt?: string;
  command?: string;
  cwd?: string;
  error?: string;
  permissionDecision?: {
    risk?: "low" | "medium" | "high" | "critical";
    reason?: string;
    ruleId?: string;
  };
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
    if (obj.status === "blocked") return `已拦截：${obj.error ?? "调用未执行"}`;
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
    return typeof value.error === "string" && value.requiresConfirmation !== true && !isToolCallBlocked(result);
  } catch {
    return false;
  }
}

export function isToolCallBlocked(result: string | undefined): boolean {
  if (!result) return false;
  try {
    return JSON.parse(result)?.status === "blocked";
  } catch {
    return false;
  }
}

export function isToolCallRunning(toolCall: ToolCallInfo): boolean {
  return toolCall.result === undefined && (toolCall.status === "running"
    || (!toolCall.status && toolCall.startedAt !== undefined && toolCall.completedAt === undefined));
}

export function isToolCallWaiting(result: string | undefined): boolean {
  try { return !!result && JSON.parse(result).status === "waiting_user"; }
  catch { return false; }
}

export default function ToolCallBlock({ toolCall, onApproveAndResume, onApproveTurnAndResume, onRejectAndResume }: Props) {
  let originalUrl: string | undefined;
  try {
    const value = JSON.parse(toolCall.result ?? "");
    if (value.truncated === true && typeof value.originalUrl === "string" && value.originalUrl.startsWith("/tool-result?")) originalUrl = value.originalUrl;
  } catch { /* Plain text results do not carry an original-content link. */ }
  const approval = parseApprovalResult(toolCall.result);
  const [approvalStatus, setApprovalStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [approvalMessage, setApprovalMessage] = useState("");
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const isRunning = isToolCallRunning(toolCall);
  const failed = isToolCallFailure(toolCall.result);
  const blocked = isToolCallBlocked(toolCall.result);
  const [now, setNow] = useState(Date.now());
  const [renewedExpiresAt, setRenewedExpiresAt] = useState<string>();
  const expiresAt = renewedExpiresAt ?? approval?.expiresAt;
  const expired = (expiresAt ? Date.parse(expiresAt) <= now : false)
    || (!renewedExpiresAt && approval?.approvalStatus === "expired");
  const inputStr = JSON.stringify(toolCall.input, null, 2);
  const inputSummary = summarizeInput(toolCall.name, toolCall.input);
  const resultSummary = summarizeResult(toolCall.result);
  const elapsedMs = useElapsedTime(toolCall.startedAt, toolCall.completedAt, isRunning);
  const statusLabel = isToolCallWaiting(toolCall.result) ? "等待回答" : approval
    ? expired ? "审批已过期" : "待审批"
    : isRunning
      ? "执行中"
      : toolCall.result === undefined
        ? toolCall.status === "interrupted" ? "已中断" : "结果未知"
      : blocked
        ? "已拦截"
      : failed
        ? "失败"
        : "成功";

  useEffect(() => {
    setRenewedExpiresAt(undefined);
    setApprovalStatus("pending");
  }, [approval?.approvalId]);

  useEffect(() => {
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    setNow(Date.now());
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const handleRenew = async () => {
    if (!approval) return;
    setIsSubmittingApproval(true);
    try {
      const renewed = await renewCommand(approval.approvalId);
      setRenewedExpiresAt(renewed.expiresAt);
      setNow(Date.now());
      setApprovalMessage("已重新申请，请核对命令后批准。命令尚未执行。");
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : "重新申请失败");
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  const handleApprove = async () => {
    if (!approval || expired) return;
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
      if (onRejectAndResume) await onRejectAndResume(approval.approvalId);
      else await rejectCommand(approval.approvalId);
      setApprovalStatus("rejected");
      setApprovalMessage("已拒绝，任务已继续处理。");
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : "拒绝失败");
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  const handleApproveTurn = async () => {
    if (!approval || expired || !onApproveTurnAndResume) return;
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
    <details className={`tool-block ${isRunning ? "is-running" : ""} ${!isRunning && toolCall.result === undefined ? "is-inactive" : ""} ${failed ? "is-failed" : ""} ${approval ? "is-approval" : ""}`} open={approval || isRunning ? true : undefined}>
      <summary>
        <span className="tool-name">{toolCall.name}</span>
        {inputSummary && <span className="tool-input-summary">{inputSummary}</span>}
        {resultSummary && <span className="tool-result-summary">{resultSummary}</span>}
        <span className="tool-status" role="status" title={toolCall.name === "background_start" ? "启动工具调用耗时；后台任务运行时间见任务状态" : undefined}>{statusLabel}{!approval && elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : ""}</span>
      </summary>
      <div className={`tool-body ${approval ? "tool-body-approval" : ""}`}>
        {approval ? (
          <div className="tool-approval">
            <div className="tool-approval-content">
              <div><strong>Input:</strong></div>
              <div>{inputStr}</div>
              <div style={{ marginTop: 8 }}><strong>Result:</strong></div>
              <div>
                <div className="tool-approval-title">{expired ? "审批已过期" : "此工具调用需要批准"}</div>
                {expiresAt && <div>到期时间：<time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time></div>}
                {expired && <div>命令尚未执行。可重新申请审批，或点击输入框中的“停止”取消任务。</div>}
                {approval.error && <div>{approval.error}</div>}
                {approval.permissionDecision?.reason && (
                  <div className="tool-approval-reason">
                    自动判断：{approval.permissionDecision.reason}
                    {approval.permissionDecision.risk && `（风险：${approval.permissionDecision.risk}）`}
                  </div>
                )}
                <div>审批 ID：<code>{approval.approvalId}</code></div>
                {approval.command && <pre>{approval.command}</pre>}
                {approval.cwd && <div>目录：{approval.cwd}</div>}
                <div className="tool-approval-hint">“允许本轮”仅对当前用户消息的后续权限申请生效，不会修改权限配置。</div>
              </div>
            </div>
            <div className="tool-approval-footer">
                <div className="tool-approval-actions">
                  {expired && <button onClick={handleRenew} disabled={isSubmittingApproval}>重新申请审批</button>}
                  <button onClick={handleApprove} disabled={expired || isSubmittingApproval || approvalStatus !== "pending"}>
                    {approvalStatus === "approved" ? "已批准" : "批准本次"}
                  </button>
                  {onApproveTurnAndResume && (
                    <button className="approve-turn" onClick={handleApproveTurn} disabled={expired || isSubmittingApproval || approvalStatus !== "pending"}>
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
            {isRunning && (
              <div className="tool-running-message">
                <span className="tool-running-spinner" aria-hidden="true" />
                <span>等待工具返回结果...</span>
              </div>
            )}
            {toolCall.result !== undefined && (
              <>
                <div style={{ marginTop: 8 }}><strong>Result:</strong></div>
                {originalUrl && <div>内容已精简 · <a href={originalUrl} download>下载完整结果</a></div>}
              <Markdown>{toolCall.result}</Markdown>
              </>
            )}
            {!isRunning && toolCall.result === undefined && (
              <div role="status">{toolCall.statusReason ?? "未记录工具执行结果，当前无法确认执行情况"}</div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
