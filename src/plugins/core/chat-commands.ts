import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config.js";
import { estimateTokens } from "../../estimate-tokens.js";
import { approveRequest, listApprovals, rejectRequest } from "../../tools/approval.js";
import { createBashTool } from "../../tools/bash.js";
import { deleteStoredSession } from "../../session-store.js";
import type { ChatCommand, ChatCommandContext, Plugin } from "../types.js";

export const coreChatCommandsPlugin: Plugin = {
  name: "core-chat-commands",

  async init(ctx): Promise<void> {
    const commands: ChatCommand[] = [
      {
        name: "help",
        description: "列出可用聊天命令",
        usage: "/help [命令名]",
        execute: (commandCtx) => ({ text: formatHelp(commandCtx) }),
      },
      {
        name: "approvals",
        description: "列出当前可处理的命令审批",
        usage: "/approvals",
        execute: (commandCtx) => ({ text: listApprovalText(commandCtx) }),
      },
      {
        name: "new",
        aliases: ["reset"],
        description: "开启一个新会话",
        usage: "/new",
        execute: (commandCtx) => newConversation(ctx, commandCtx),
      },
      {
        name: "context",
        aliases: ["ctx"],
        description: "显示当前会话上下文长度估算",
        usage: "/context",
        execute: (commandCtx) => ({ text: contextLengthText(commandCtx) }),
      },
      {
        name: "approve",
        description: "批准一条命令审批",
        usage: "/approve <审批 ID>",
        execute: (commandCtx) => approveCommand(ctx, commandCtx),
      },
      {
        name: "reject",
        description: "拒绝一条命令审批",
        usage: "/reject <审批 ID>",
        execute: (commandCtx) => ({ text: rejectApprovalText(commandCtx) }),
      },
    ];

    for (const command of commands) ctx.registerChatCommand(command);
  },
};

function formatHelp(ctx: ChatCommandContext): string {
  if (ctx.args[0]) {
    const commandName = ctx.args[0].replace(/^\//, "").toLowerCase();
    const command = ctx.getChatCommands().find((item) => item.name === commandName || item.aliases?.includes(commandName));
    if (!command) return `未知命令：/${commandName}\n发送 /help 查看可用命令。`;
    return [
      `/${command.name}`,
      command.description,
      command.usage ? `用法：${command.usage}` : "",
      command.aliases?.length ? `别名：${command.aliases.map((alias) => `/${alias}`).join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }

  return [
    "可用命令：",
    ...ctx.getChatCommands().map((command) => {
      const usage = command.usage ?? `/${command.name}`;
      return `- \`${usage}\`：${command.description}`;
    }),
  ].join("\n");
}

function newConversation(pluginCtx: Parameters<Plugin["init"]>[0], ctx: ChatCommandContext): { text: string; sessionId?: string; clearMessages?: boolean } {
  if (ctx.channel === "web") {
    const session = pluginCtx.getOrCreateSession(randomUUID());
    return {
      text: `已创建新会话：${session.id.slice(0, 8)}`,
      sessionId: session.id,
      clearMessages: true,
    };
  }

  if (ctx.channel === "feishu") {
    pluginCtx.deleteSession(ctx.sessionId);
    deleteStoredSession(ctx.workspacePath, ctx.sessionId);
    pluginCtx.getOrCreateSession(ctx.sessionId);
    return { text: "已重置当前飞书会话上下文。下一条消息会从新上下文开始。" };
  }

  return { text: "已开始新会话。" };
}

function contextLengthText(ctx: ChatCommandContext): string {
  if (!ctx.history || !ctx.config) return "当前会话上下文尚未初始化。";

  const windowMessages = ctx.history.getRecentMessages(ctx.config.historyWindowSize);
  const allMessages = ctx.history.getRecentMessages(Infinity);
  const currentTurnMessages = ctx.history.getCurrentTurnMessages();
  const windowTokens = estimateTokens(windowMessages);
  const allTokens = estimateTokens(allMessages);
  const currentTurnTokens = estimateTokens(currentTurnMessages);
  const maxContextTokens = ctx.config.maxContextTokens;
  const threshold = Math.floor(maxContextTokens * ctx.config.contextCompressionThreshold);
  const percent = maxContextTokens > 0 ? Math.round((windowTokens / maxContextTokens) * 100) : 0;
  const thresholdPercent = maxContextTokens > 0 ? Math.round((threshold / maxContextTokens) * 100) : 0;

  return [
    "当前上下文长度估算：",
    `- 当前发送窗口：${windowTokens} tokens，${windowMessages.length} 条消息，约 ${percent}% / ${maxContextTokens}`,
    `- 压缩阈值：${threshold} tokens，约 ${thresholdPercent}%`,
    `- 当前轮：${currentTurnTokens} tokens，${currentTurnMessages.length} 条消息`,
    `- 会话完整历史：${allTokens} tokens，${allMessages.length} 条消息`,
    "",
    "说明：这是粗略估算，用于判断是否接近上下文上限；实际模型 token 统计可能不同。",
  ].join("\n");
}

function listApprovalText(ctx: ChatCommandContext): string {
  const approvals = listApprovals(ctx.workspacePath, ctx.actor);
  if (approvals.length === 0) return "暂无你可以处理的命令审批。";
  return approvals.map((approval) => [
    `审批 ID：${approval.id}`,
    `状态：${approval.status === "approved" ? "已允许一次" : "待审批"}`,
    `来源：${approval.source}`,
    `命令：${approval.command}`,
    `有效期至：${approval.expiresAt}`,
    `批准：/approve ${approval.id}`,
    `拒绝：/reject ${approval.id}`,
  ].join("\n")).join("\n\n");
}

async function approveCommand(pluginCtx: Parameters<Plugin["init"]>[0], ctx: ChatCommandContext): Promise<{ text: string }> {
  const id = ctx.args[0];
  if (!id) return { text: "用法：/approve <审批 ID>" };

  const approval = approveRequest(ctx.workspacePath, id, ctx.actor);
  if (!approval) return { text: "审批记录不存在、已过期，或你无权处理该审批。" };
  if (approval.sessionId) {
    const resumed = await resumeApprovedSession(pluginCtx, approval.sessionId, approval.id, ctx.actor);
    if (resumed) return { text: resumed };
  }

  if (ctx.channel !== "feishu" || approval.source !== "bash") {
    return { text: "已批准该命令执行一次。请重新发送原任务，下一次相同命令会执行一次。" };
  }

  const bash = createBashTool(ctx.workspacePath, () => loadConfig(ctx.workspacePath));
  const result = await bash.execute(
    { command: approval.command, cwd: approval.cwd },
    { actor: approval.actor, sessionId: approval.sessionId },
  );
  return { text: formatApprovedBashResult(approval.command, result) };
}

async function resumeApprovedSession(
  pluginCtx: Parameters<Plugin["init"]>[0],
  sessionId: string,
  approvalId: string,
  actor: ChatCommandContext["actor"],
): Promise<string | undefined> {
  let session: ReturnType<typeof pluginCtx.getOrCreateSession>;
  try {
    session = pluginCtx.getOrCreateSession(sessionId);
  } catch {
    return undefined;
  }

  const lines: string[] = [];
  for await (const event of session.resumeApproval(approvalId, actor)) {
    if (event.type === "text_delta") {
      lines.push(event.text);
    } else if (event.type === "tool_call") {
      lines.push(`\n[工具调用] ${event.name}(${JSON.stringify(event.input)})\n`);
    } else if (event.type === "tool_result") {
      lines.push(`\n[工具结果] ${formatToolResult(event.result)}\n`);
    } else if (event.type === "error") {
      return undefined;
    }
  }

  const text = lines.join("").trim();
  return text ? `已批准，并继续执行原任务。\n\n${text}` : "已批准，并继续执行原任务。";
}

function formatToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as { stdout?: string; stderr?: string; exitCode?: number; error?: string };
    return [
      parsed.stdout ? `标准输出：\n${parsed.stdout.trimEnd()}` : "",
      parsed.stderr ? `标准错误：\n${parsed.stderr.trimEnd()}` : "",
      parsed.error ? `错误：${parsed.error}` : "",
      typeof parsed.exitCode === "number" ? `退出码：${parsed.exitCode}` : "",
    ].filter(Boolean).join("\n\n") || truncate(result, 500);
  } catch {
    return truncate(result, 500);
  }
}

function rejectApprovalText(ctx: ChatCommandContext): string {
  const id = ctx.args[0];
  if (!id) return "用法：/reject <审批 ID>";
  return rejectRequest(ctx.workspacePath, id, ctx.actor)
    ? "已拒绝该命令。"
    : "审批记录不存在、已过期，或你无权处理该审批。";
}

function formatApprovedBashResult(command: string, result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
      requiresConfirmation?: boolean;
    };
    if (parsed.requiresConfirmation) {
      return [
        "已批准，但命令没有被执行。",
        parsed.error ?? "执行时仍然需要新的授权；请重新查看最新审批。",
      ].join("\n");
    }
    return [
      "已批准并执行该命令。",
      `命令：${truncate(command, 500)}`,
      parsed.stdout ? `标准输出：\n${parsed.stdout.trimEnd()}` : "",
      parsed.stderr ? `标准错误：\n${parsed.stderr.trimEnd()}` : "",
      `退出码：${parsed.exitCode ?? -1}`,
    ].filter(Boolean).join("\n\n");
  } catch {
    return [
      "已批准并执行该命令。",
      `命令：${truncate(command, 500)}`,
      `[工具结果] ${truncate(result, 500)}`,
    ].join("\n\n");
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
