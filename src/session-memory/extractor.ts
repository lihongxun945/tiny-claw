import type { ModelClient } from "../model/types.js";
import type { Message } from "../types.js";
import { estimateTextTokens, estimateTokens } from "../estimate-tokens.js";
import type { PersistedSessionSummary, SummaryDelta } from "./types.js";
import {
  parseSummaryDeltaDraft,
  validateSummaryDelta,
  type SummaryValidationLimits,
} from "./validation.js";

export interface ExtractSummaryDeltaInput {
  signal?: AbortSignal;
  sessionId: string;
  current: PersistedSessionSummary;
  messages: Message[];
  maxInputChars: number;
  limits: SummaryValidationLimits;
  maxOutputTokens: number;
  maxContextTokens?: number;
}

const SYSTEM_PROMPT = `你是会话状态变更提取器。
只输出一个 JSON 对象，不要解释，不要 Markdown。
只能依据提供的消息提取信息，不得推测来源。
不要生成条目 ID、时间或消息序号；sourceMessageIds 必须逐字使用输入中的 messageId。`;

export async function extractSummaryDelta(
  client: ModelClient,
  input: ExtractSummaryDeltaInput,
): Promise<SummaryDelta> {
  const messages = input.messages.filter(
    (message): message is Message & { _messageId: string; _sequence: number } =>
      !!message._messageId && Number.isInteger(message._sequence),
  );
  if (messages.length === 0) throw new Error("没有可供结构化摘要提取的持久化消息");
  const fromSequence = input.current.summarizedThroughSequence + 1;
  const renderPrompt = (batch: typeof messages) => JSON.stringify({
    task: "生成会话摘要 Delta",
    schema: {
      baseRevision: input.current.revision,
      sourceRange: { fromSequence, throughSequence: batch[batch.length - 1]._sequence },
      operations: [{
        type: "add | supersede | resolve",
        category: "goals | constraints | facts | decisions | completed | pending | resources",
        item: { text: "add 时使用", sourceMessageIds: ["msg_id"] },
        targetId: "supersede/resolve 时使用",
        replacement: { text: "supersede 时使用", sourceMessageIds: ["msg_id"] },
        sourceMessageIds: ["resolve 时使用"],
      }],
    },
    rules: [
      "顶层和操作对象不得增加 schema 之外的字段",
      "没有值得记录的信息时 operations 输出空数组",
      "supersede/resolve 的 targetId 只能来自 activeItems",
      "每个操作必须引用至少一条本次 messages 中的 messageId",
    ],
    activeItems: Object.entries(input.current.checkpoint.categories).flatMap(([category, items]) =>
      items.filter((item) => item.status === "active").map((item) => ({ id: item.id, category, text: item.text })),
    ),
    messages: batch
      .map((message) => ({
        messageId: message._messageId,
        sequence: message._sequence,
        turnId: message._turnId,
        role: message.role,
        content: renderContent(message),
      })),
  });
  // Commit complete historical turns, never half of a tool exchange.
  const boundaries = messages.flatMap((message, index) => index > 0 && message.role === "user"
    && (typeof message.content === "string" || message.content.some((block) => block.type === "text" || block.type === "image"))
    ? [index] : []);
  boundaries.push(messages.length);
  let low = 1;
  let high = boundaries.length;
  let count = 0;
  let prompt = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle - 1];
    const candidate = renderPrompt(messages.slice(0, boundary));
    const fits = candidate.length + SYSTEM_PROMPT.length <= input.maxInputChars
      && (input.maxContextTokens === undefined || estimateTokens([{ role: "user", content: candidate }]) + estimateTextTokens(SYSTEM_PROMPT) + input.maxOutputTokens <= input.maxContextTokens);
    if (fits) {
      count = boundary;
      prompt = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (count === 0) throw new Error("摘要请求超过输入字符或模型上下文预算，保留原文和已有摘要；请调整 sessionSummary.maxInputChars 或缩小单条工具结果");
  const output = await client.complete(
    [{ role: "user", content: prompt }],
    SYSTEM_PROMPT,
    { maxTokens: input.maxOutputTokens, signal: input.signal },
  );
  return validateSummaryDelta(parseSummaryDeltaDraft(output), {
    sessionId: input.sessionId,
    current: input.current,
    messages: messages.slice(0, count),
    limits: input.limits,
  });
}

function renderContent(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_use") return `[工具调用 ${block.name}] ${JSON.stringify(block.input)}`;
    if (block.type === "tool_result") return `[工具结果] ${block.content}`;
    return `[图片] ${block.name}`;
  }).join("\n");
}
