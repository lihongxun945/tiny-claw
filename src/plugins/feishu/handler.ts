import { AgentSession } from "../../agent.js";
import type { AgentActor } from "../../types.js";
import { FeishuClient, splitMessage } from "./client.js";

const STREAM_PLACEHOLDER = "正在处理...";
const STREAM_FLUSH_INTERVAL_MS = 1_000;

type ReplyClient = Pick<FeishuClient, "replyMessage" | "updateMessageCard">;
type ChatCommandRunner = (input: string, actor: AgentActor) => Promise<string | undefined>;

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
  _workspacePath: string,
  actor: AgentActor,
  runChatCommand?: ChatCommandRunner,
): Promise<void> {
  const commandReply = runChatCommand ? await runChatCommand(userText, actor) : undefined;
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
        stream.append(`\n${formatToolResultForFeishu(event.result)}\n`);
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

function formatToolResultForFeishu(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      requiresConfirmation?: boolean;
      approvalId?: string;
      approvalCommand?: string;
      approvalTurnCommand?: string;
      command?: string;
      cwd?: string;
      error?: string;
      permissionDecision?: { risk?: string; reason?: string };
    };
    if (parsed.requiresConfirmation && parsed.approvalCommand) {
      return [
        "[需要授权]",
        "请回复下面这条完整命令进行批准：",
        parsed.approvalCommand,
        parsed.approvalTurnCommand ? `允许本轮全部权限：${parsed.approvalTurnCommand}` : "",
        "",
        "只回复“批准”不会生效。",
        "批准后系统会立即继续原任务；授权只对本次列出的工具调用生效。",
        parsed.permissionDecision?.reason ? `自动判断：${parsed.permissionDecision.reason}${parsed.permissionDecision.risk ? `（风险：${parsed.permissionDecision.risk}）` : ""}` : "",
        parsed.command ? `命令：${truncate(parsed.command, 500)}` : "",
      ].filter(Boolean).join("\n");
    }
  } catch {
    // 非 JSON 工具结果按普通文本展示。
  }
  return `[工具结果] ${result.slice(0, 500)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
