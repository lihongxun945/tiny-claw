import { AgentSession } from "../../agent.js";
import type { AgentActor } from "../../types.js";
import { approveRequest, listApprovals, rejectRequest } from "../../tools/approval.js";
import { FeishuClient, splitMessage } from "./client.js";

const STREAM_PLACEHOLDER = "正在处理...";
const STREAM_FLUSH_INTERVAL_MS = 1_000;

type ReplyClient = Pick<FeishuClient, "replyMessage" | "updateMessageCard">;

class FeishuStreamReply {
  private replyMessageId = "";
  private text = "";
  private lastSent = "";
  private lastFlushAt = 0;

  constructor(
    private client: ReplyClient,
    private sourceMessageId: string,
  ) {}

  async start(): Promise<void> {
    const ids = await this.client.replyMessage(this.sourceMessageId, STREAM_PLACEHOLDER);
    this.replyMessageId = ids[0] ?? "";
    this.lastSent = STREAM_PLACEHOLDER;
  }

  append(chunk: string): void {
    this.text += chunk;
  }

  async flush(force = false): Promise<void> {
    if (!this.replyMessageId) return;
    const now = Date.now();
    if (!force && now - this.lastFlushAt < STREAM_FLUSH_INTERVAL_MS) return;
    const current = splitMessage(this.text.trim() || STREAM_PLACEHOLDER)[0] ?? STREAM_PLACEHOLDER;
    if (current === this.lastSent) return;
    await this.client.updateMessageCard(this.replyMessageId, current);
    this.lastSent = current;
    this.lastFlushAt = now;
  }

  async finish(): Promise<void> {
    if (!this.text.trim()) return;
    const chunks = splitMessage(this.text.trim());
    if (this.replyMessageId) {
      await this.client.updateMessageCard(this.replyMessageId, chunks[0] ?? this.text.trim());
      this.lastSent = chunks[0] ?? this.text.trim();
    } else {
      await this.client.replyMessage(this.sourceMessageId, chunks[0] ?? this.text.trim());
    }
    if (chunks.length > 1) {
      await this.client.replyMessage(this.sourceMessageId, chunks.slice(1).join("\n"));
    }
  }
}

export async function processFeishuMessage(
  session: AgentSession,
  userText: string,
  messageId: string,
  client: ReplyClient,
  workspacePath: string,
  actor: AgentActor,
): Promise<void> {
  const commandReply = handleApprovalCommand(workspacePath, userText, actor);
  if (commandReply !== undefined) {
    await client.replyMessage(messageId, commandReply);
    return;
  }

  const stream = new FeishuStreamReply(client, messageId);
  await stream.start();

  for await (const event of session.chat(userText, actor)) {
    switch (event.type) {
      case "text_delta":
        stream.append(event.text);
        await stream.flush();
        break;
      case "tool_call":
        stream.append(`\n[工具调用] ${event.name}(${JSON.stringify(event.input).slice(0, 200)})\n`);
        await stream.flush(true);
        break;
      case "tool_result":
        stream.append(`\n[工具结果] ${event.result.slice(0, 500)}\n`);
        await stream.flush(true);
        break;
      case "error":
        stream.append(`\n错误: ${event.message}`);
        await stream.flush(true);
        break;
      case "done":
        break;
    }
  }

  await stream.finish();
}

export function handleApprovalCommand(workspacePath: string, userText: string, actor: AgentActor): string | undefined {
  const text = userText.trim();
  if (text === "/approvals") {
    const approvals = listApprovals(workspacePath, actor);
    if (approvals.length === 0) return "暂无你可以处理的命令审批。";
    return approvals.map((approval) => [
      `审批 ID：${approval.id}`,
      `状态：${approval.status === "approved" ? "已允许一次" : "待审批"}`,
      `来源：${approval.source}`,
      `命令：${approval.command}`,
      `有效期至：${approval.expiresAt}`,
      `允许一次：/approve ${approval.id}`,
      `拒绝：/reject ${approval.id}`,
    ].join("\n")).join("\n\n");
  }

  const match = text.match(/^\/(approve|reject)\s+(\S+)$/);
  if (!match) return undefined;
  const [, action, id] = match;
  if (action === "approve") {
    const approval = approveRequest(workspacePath, id, actor);
    return approval
      ? "已允许该命令执行一次，请重新发送原任务。"
      : "审批记录不存在、已过期，或你无权处理该审批。";
  }
  return rejectRequest(workspacePath, id, actor)
    ? "已拒绝该命令。"
    : "审批记录不存在、已过期，或你无权处理该审批。";
}
