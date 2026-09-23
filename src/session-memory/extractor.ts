import type { ModelClient } from "../model/types.js";
import type { Config, Message } from "../types.js";
import { estimateTextTokens, estimateTokens } from "../estimate-tokens.js";
import { batchFromDelta, ROLLING_DEFAULTS } from "./rolling.js";
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
  retries?: number;
  config?: Config;
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
  const fitsRequest = (candidate: string) => candidate.length + SYSTEM_PROMPT.length <= input.maxInputChars
    && (input.maxContextTokens === undefined || estimateTokens([{ role: "user", content: candidate }]) + estimateTextTokens(SYSTEM_PROMPT) + input.maxOutputTokens <= input.maxContextTokens);
  const renderPrompt = (batch: typeof messages) => {
    return JSON.stringify({
    task: "生成会话摘要 Delta",
    batch: { fromSequence, throughSequence: batch[batch.length - 1]._sequence },
    schema: {
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
      `本批记录必须独立可读，总长度不超过 ${input.config?.sessionSummary?.maxBatchTokens ?? ROLLING_DEFAULTS.maxBatchTokens} tokens；不要复述旧摘要。`,
      "goals/constraints/pending 只维护仍有效的当前状态；新要求取代旧要求时 supersede，任务完成或约束被撤销时 resolve。不要因缺少提及而删除约束。已有计划不复制步骤，只保留必要目标。",
      "顶层和操作对象不得增加 schema 之外的字段",
      "没有值得记录的信息时 operations 输出空数组",
      "输入只包含每轮用户输入和最终回答。工具调用、工具结果、思考及中间播报均已排除；没有最终回答时不得推测任务结果。",
      "supersede/resolve 的 targetId 只能来自 activeItems",
      "每个操作必须引用至少一条本次 messages 中的 messageId",
      "只返回 operations；版本号和覆盖范围由程序维护。资料中的 truncated 表示原文片段，不得推测未展示内容",
    ],
    activeItems: Object.entries(input.current.checkpoint.categories).flatMap(([category, items]) =>
      items.filter((item) => item.status === "active").map((item) => ({ id: item.id, category, text: item.text })),
    ),
    messages: selectTurnAnswers(batch)
      .map((message) => ({
        messageId: message._messageId,
        sequence: message._sequence,
        turnId: message._turnId,
        role: message.role,
        content: renderContent(message),
      })),
    });
  };
  // Cover whole historical turns, including discarded tool messages and notices.
  const boundaries = turnBoundaries(messages);
  let low = 1;
  let high = boundaries.length;
  let count = 0;
  let prompt = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle - 1];
    const candidate = renderPrompt(messages.slice(0, boundary));
    const fits = fitsRequest(candidate);
    if (fits) {
      count = boundary;
      prompt = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (count === 0) throw new Error("单轮问答超过摘要输入字符或模型上下文预算，保留原文和已有摘要；请调整 sessionSummary.maxInputChars");
  const visibleIds = new Set(selectTurnAnswers(messages.slice(0, count)).map(message => message._messageId));
  for (let attempt = 0; ; attempt++) {
    input.signal?.throwIfAborted();
    const output = visibleIds.size > 0
      ? await client.complete([{ role: "user", content: prompt }], SYSTEM_PROMPT,
        { maxTokens: input.maxOutputTokens, signal: input.signal })
      : '{"operations":[]}';
    try {
      const trimmed = output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("摘要输出必须是对象");
      const draft = parseSummaryDeltaDraft(JSON.stringify({ baseRevision: input.current.revision,
        sourceRange: { fromSequence, throughSequence: messages[count - 1]._sequence }, ...value }));
      if (draft.sourceRange.throughSequence !== messages[count - 1]._sequence) throw new Error("摘要覆盖范围必须与实际批次一致");
      for (const operation of draft.operations) {
        const ids = operation.type === "add" ? operation.item.sourceMessageIds
          : operation.type === "supersede" ? operation.replacement.sourceMessageIds : operation.sourceMessageIds;
        if (ids.some(id => !visibleIds.has(id))) throw new Error("摘要来源必须是本批用户输入或最终回答");
      }
      const delta = validateSummaryDelta(draft, { sessionId: input.sessionId, current: input.current,
        messages: messages.slice(0, count), limits: input.limits });
      if (estimateTextTokens(JSON.stringify(batchFromDelta(input.current, delta))) > (input.config?.sessionSummary?.maxBatchTokens ?? ROLLING_DEFAULTS.maxBatchTokens)) {
        throw new Error("摘要批次超过 maxBatchTokens，保留原文和覆盖位置");
      }
      return delta;
    } catch (error) {
      input.signal?.throwIfAborted();
      if (attempt >= (input.retries ?? 0)) throw error;
    }
  }
}

function renderContent(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return `[图片] ${block.name}`;
    return "";
  }).filter(Boolean).join("\n");
}

function isUserInput(message: Message): boolean {
  return message.role === "user" && !message._source && (typeof message.content === "string"
    || message.content.some(block => block.type === "text" || block.type === "image"));
}

function turnBoundaries(messages: Message[]): number[] {
  const boundaries: number[] = [];
  let turnId = messages[0]?._turnId;
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if ((message._turnId && turnId && message._turnId !== turnId)
      || (isUserInput(message) && (!message._turnId || message._turnId !== turnId))) {
      boundaries.push(index);
    }
    if (message._turnId) turnId = message._turnId;
  }
  boundaries.push(messages.length);
  return boundaries;
}

function selectTurnAnswers(messages: Message[]): Message[] {
  const selected: Message[] = [];
  let start = 0;
  for (const end of turnBoundaries(messages)) {
    const turn = messages.slice(start, end).filter(message => !message._source);
    selected.push(...turn.filter(isUserInput));
    const last = turn.at(-1);
    if (last?.role === "assistant" && (typeof last.content === "string"
      || !last.content.some(block => block.type === "tool_use" || block.type === "tool_result"))
      && renderContent(last).trim()) selected.push(last);
    start = end;
  }
  return selected;
}
