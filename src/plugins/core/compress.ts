import type { Plugin, HookContext } from "../types.js";
import type { Message, Config } from "../../types.js";
import { estimateTokens } from "../../estimate-tokens.js";

const SESSION_SUMMARY_MARKER = "[当前会话摘要]";
const HISTORY_SUMMARY_MARKER = "[以下是对话历史的摘要]";
const SYNTHETIC_SUMMARY_MARKERS = [SESSION_SUMMARY_MARKER, HISTORY_SUMMARY_MARKER];
const MIN_TOOL_RESULT_CHAR_LIMIT = 1_000;
const DEFAULT_CONTEXT_COMPRESSION_MAX_CHARS = 5000;
const DEFAULT_CONTEXT_COMPRESSION_TOOL_RESULT_MAX_CHARS = 500;
const DEFAULT_TOOL_RESULT_INITIAL_MAX_CHARS = 12_000;

function getRecentTurns(config: Config): number {
  const value = config.sessionSummary?.recentTurns;
  if (!Number.isFinite(value) || !value || value < 1) return 3;
  return Math.min(Math.floor(value), 20);
}

function getCompressionMaxChars(config: Config): number {
  const value = config.contextCompressionMaxChars;
  if (!Number.isFinite(value) || value < 100) return DEFAULT_CONTEXT_COMPRESSION_MAX_CHARS;
  return Math.floor(value);
}

function getCompressionToolResultMaxChars(config: Config): number {
  const value = config.contextCompressionToolResultMaxChars;
  if (!Number.isFinite(value) || value < 100) return DEFAULT_CONTEXT_COMPRESSION_TOOL_RESULT_MAX_CHARS;
  return Math.floor(value);
}

function getToolResultInitialMaxChars(config: Config): number {
  const value = config.toolResultInitialMaxChars;
  if (!Number.isFinite(value) || value < MIN_TOOL_RESULT_CHAR_LIMIT) return DEFAULT_TOOL_RESULT_INITIAL_MAX_CHARS;
  return Math.floor(value);
}

function compressPrompt(maxChars: number): string {
  return `请将以下对话历史压缩为一段简洁的摘要，保留关键信息（事实、决策、结论），省略细节和中间过程。用中文输出，不超过 ${maxChars} 字。`;
}

function isSyntheticSummaryMessage(message: Message): boolean {
  if (typeof message.content === "string") {
    const content = message.content;
    return SYNTHETIC_SUMMARY_MARKERS.some((marker) => content.startsWith(marker));
  }
  const first = message.content[0];
  return first?.type === "text"
    && typeof first.text === "string"
    && SYNTHETIC_SUMMARY_MARKERS.some((marker) => first.text.startsWith(marker));
}

function summaryMarker(message: Message): string | undefined {
  if (typeof message.content === "string") {
    const content = message.content;
    return SYNTHETIC_SUMMARY_MARKERS.find((marker) => content.startsWith(marker));
  }
  const first = message.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return undefined;
  return SYNTHETIC_SUMMARY_MARKERS.find((marker) => first.text.startsWith(marker));
}

function normalizePreviousSyntheticSummaries(
  previousMessages: Message[],
): Message[] {
  let sessionSummary: Message | undefined;
  let historySummary: Message | undefined;
  const rawMessages: Message[] = [];

  for (const message of previousMessages) {
    const marker = summaryMarker(message);
    if (marker === SESSION_SUMMARY_MARKER) {
      sessionSummary = message;
    } else if (marker === HISTORY_SUMMARY_MARKER) {
      historySummary = message;
    } else {
      rawMessages.push(message);
    }
  }

  return [
    ...(sessionSummary ? [sessionSummary] : []),
    ...(historySummary ? [historySummary] : []),
    ...rawMessages,
  ];
}

function truncateToolResultContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n...[工具结果已截断，原始长度 ${content.length} 字符]`;
}

function clampToolResults(messages: Message[], budgetTokens: number, initialMaxChars: number): Message[] {
  if (estimateTokens(messages) <= budgetTokens) return messages;

  let limit = initialMaxChars;
  let clamped = messages;

  while (limit >= MIN_TOOL_RESULT_CHAR_LIMIT) {
    clamped = messages.map((message) => {
      if (typeof message.content === "string") return message;
      return {
        ...message,
        content: message.content.map((block) => block.type === "tool_result"
          ? { ...block, content: truncateToolResultContent(block.content, limit) }
          : block),
      };
    });

    if (estimateTokens(clamped) <= budgetTokens) return clamped;
    limit = Math.floor(limit / 2);
  }

  return clamped;
}

async function compressMessages(
  messages: Message[],
  ctx: HookContext,
): Promise<Message[]> {
  const toolResultMaxChars = getCompressionToolResultMaxChars(ctx.config);
  const text = messages
    .map((msg) => {
      if (typeof msg.content === "string") {
        return `[${msg.role}]: ${msg.content}`;
      }
      const parts = msg.content.map((block) => {
        if (block.type === "text") return `[文本]: ${block.text}`;
        if (block.type === "tool_use") return `[工具调用 ${block.name}]: ${JSON.stringify(block.input)}`;
        if (block.type === "tool_result") return `[工具结果]: ${block.content.slice(0, toolResultMaxChars)}`;
        return "";
      });
      return `[${msg.role}]: ${parts.join(" | ")}`;
    })
    .join("\n");

  try {
    const summary = await ctx.client.complete(
      [{ role: "user", content: `${compressPrompt(getCompressionMaxChars(ctx.config))}\n\n---\n${text}` }],
      "你是一个对话摘要助手，只输出摘要，不要有任何额外说明。",
    );

    return [
      {
        role: "user",
        content: `[以下是对话历史的摘要]\n${summary}`,
      },
    ];
  } catch {
    return messages.slice(-2);
  }
}

export const coreCompressPlugin: Plugin = {
  name: "core-compress",
  async init(ctx) {
    const config = ctx.config as unknown as Config;

    ctx.registerHooks({
      onBeforeModelCall: async (hookCtx: HookContext, messages: Message[]) => {
        const normalizedPreviousMessages = normalizePreviousSyntheticSummaries(
          messages.slice(0, hookCtx.turnStartIndex),
        );
        const currentMessages = messages.slice(hookCtx.turnStartIndex);
        const normalizedMessages = [...normalizedPreviousMessages, ...currentMessages];
        const tokens = estimateTokens(normalizedMessages);
        const threshold = config.maxContextTokens * config.contextCompressionThreshold;

        const toolResultInitialMaxChars = getToolResultInitialMaxChars(hookCtx.config);

        if (tokens < threshold) return clampToolResults(normalizedMessages, threshold, toolResultInitialMaxChars);

        const turnStartIdx = normalizedPreviousMessages.length;

        // 优先压缩历史对话（turnStartIdx 之前）
        const previousMessages = normalizedMessages.slice(0, turnStartIdx);

        if (previousMessages.length > 2) {
          const summaryMessages = previousMessages.filter(isSyntheticSummaryMessage);
          const rawPreviousMessages = previousMessages.filter((message) => !isSyntheticSummaryMessage(message));
          const keepCount = Math.min(rawPreviousMessages.length, Math.max(2, getRecentTurns(config) * 2));
          const toCompress = rawPreviousMessages.slice(0, -keepCount);
          let recentPrevious = rawPreviousMessages.slice(-keepCount);

          if (recentPrevious.length > 0 && recentPrevious[0].role === "assistant") {
            recentPrevious = recentPrevious.slice(1);
          }

          if (toCompress.length > 0) {
            const compressed = await compressMessages(toCompress, hookCtx);
            return clampToolResults([...summaryMessages, ...compressed, ...recentPrevious, ...currentMessages], threshold, toolResultInitialMaxChars);
          }

          return clampToolResults([...summaryMessages, ...recentPrevious, ...currentMessages], threshold, toolResultInitialMaxChars);
        }

        // 历史不足，压缩当前轮前半部分
        if (currentMessages.length > 4) {
          const splitIdx = Math.ceil(currentMessages.length / 2);
          const toCompress = currentMessages.slice(0, splitIdx);
          const toKeep = currentMessages.slice(splitIdx);
          const compressed = await compressMessages(toCompress, hookCtx);
          return clampToolResults([...compressed, ...toKeep], threshold, toolResultInitialMaxChars);
        }

        return clampToolResults(messages, threshold, toolResultInitialMaxChars);
      },
    });
  },
};
