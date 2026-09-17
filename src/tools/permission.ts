import type { Config, PermissionMode } from "../types.js";
import { requestApproval } from "./approval.js";
import type { ToolExecutionContext } from "../types.js";
import { appendLog } from "../workspace/logger.js";
import { evaluateAutoApproval, type AutoApprovalDecision } from "../security/auto-approval.js";
import { isTrustedProject, projectTempDirectory } from "../security/project-trust.js";

const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export function getToolPermissionMode(config: Config, toolName: string): PermissionMode {
  return config.security?.tools?.[toolName]?.mode
    ?? (toolName === "background_start" ? config.security?.tools?.bash?.mode : undefined)
    ?? config.security?.mode
    ?? DEFAULT_PERMISSION_MODE;
}

export function checkDangerousToolPermission(options: {
  workspacePath: string;
  config: Config;
  toolName: string;
  args: Record<string, unknown>;
  context?: ToolExecutionContext;
  command?: string;
  cwd?: string;
  prepareExecution?: boolean;
}): { allowed: true; executionCommand?: string } | { allowed: false; result: string } {
  const mode = getToolPermissionMode(options.config, options.toolName);
  if (mode === "allow") return { allowed: true };

  let autoDecision: AutoApprovalDecision | undefined;
  if (mode === "auto") {
    const root = options.context?.rootPath ?? options.workspacePath;
    const projectMode = options.context?.sessionContext?.mode === "project";
    const trustedProject = projectMode && isTrustedProject(options.config, root, options.workspacePath);
    autoDecision = evaluateAutoApproval({
      toolName: options.toolName === "background_start" ? "bash" : options.toolName,
      args: options.args,
      command: options.command,
      cwd: options.cwd,
      rootPath: options.context?.rootPath ?? options.workspacePath,
      projectMode,
      trustedProject,
      tempPath: projectMode ? projectTempDirectory(options.workspacePath, root) : undefined,
      prepareExecution: options.prepareExecution,
    });
    appendLog(
      options.workspacePath,
      "AUDIT",
      `自动权限决策 ${options.toolName} ${JSON.stringify({ action: autoDecision.action, risk: autoDecision.risk, ruleId: autoDecision.ruleId, reason: autoDecision.reason, sessionId: options.context?.sessionId })}`,
    );
    if (autoDecision.action === "allow") {
      if (autoDecision.executionCommand) appendLog(options.workspacePath, "AUDIT", `安全执行命令 ${JSON.stringify({ originalCommand: options.command ?? options.args.command, executionCommand: autoDecision.executionCommand, sessionId: options.context?.sessionId })}`);
      return { allowed: true, ...(autoDecision.executionCommand ? { executionCommand: autoDecision.executionCommand } : {}) };
    }
    if (autoDecision.action === "deny") {
      return {
        allowed: false,
        result: JSON.stringify({
          error: `${options.toolName} 被自动审批策略拒绝：${autoDecision.reason}`,
          permissionDecision: autoDecision,
        }),
      };
    }
  }

  const approval = requestApproval(
    options.workspacePath,
    options.toolName,
    options.args,
    options.config.security?.approvalTtlMs,
    options.context?.actor,
    options.context?.sessionId,
    {
      command: options.command,
      cwd: options.cwd,
    },
  );
  if (approval.approved) {
    if (approval.source === "turn") {
      appendLog(
        options.workspacePath,
        "AUDIT",
        `工具权限由本轮临时授权自动通过 ${options.toolName} ${JSON.stringify({ sessionId: options.context?.sessionId })}`,
      );
    }
    return { allowed: true };
  }

  const approvalCommand = options.context?.actor?.channel === "feishu"
    ? `/approve ${approval.approval!.id}`
    : undefined;
  return {
    allowed: false,
    result: JSON.stringify({
      error: approvalCommand
        ? `${options.toolName} 执行需要用户确认。请在飞书中回复完整命令：${approvalCommand}。只回复“批准”无效。批准后系统会立即继续执行。`
        : `${options.toolName} 执行需要用户确认。批准后系统会立即继续执行。`,
      requiresConfirmation: true,
      approvalId: approval.approval!.id,
      approvalStatus: approval.approval!.status,
      expiresAt: approval.approval!.expiresAt,
      approvalCommand,
      approvalTurnCommand: options.context?.actor?.channel === "feishu"
        ? `/approve-all ${approval.approval!.id}`
        : undefined,
      toolName: options.toolName,
      args: options.args,
      command: options.command,
      cwd: options.cwd,
      permissionDecision: autoDecision,
    }),
  };
}
