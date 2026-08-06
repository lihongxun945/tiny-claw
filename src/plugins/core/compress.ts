import type { Plugin, HookContext, ModelCallContext } from "../types.js";
import type { Message, Config } from "../../types.js";
import { estimateTokens } from "../../estimate-tokens.js";
import { getEffectiveMaxContextTokens } from "../../context-budget.js";
import { loadSessionState, updateSessionState } from "../../session-state.js";

export { getEffectiveMaxContextTokens } from "../../context-budget.js";

const SESSION_SUMMARY_MARKER = "[当前会话摘要]";
const LEGACY_HISTORY_SUMMARY_MARKER = "[以下是对话历史的摘要]";
const MIN_TOOL_RESULT_CHAR_LIMIT = 1_000;
const DEFAULT_CONTEXT_COMPRESSION_MAX_CHARS = 5000;
const DEFAULT_CONTEXT_COMPRESSION_TOOL_RESULT_MAX_CHARS = 500;
const DEFAULT_CONTEXT_COMPRESSION_MAX_OUTPUT_TOKENS = 2048;
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

function getCompressionMaxOutputTokens(config: Config): number {
  const value = config.contextCompressionMaxOutputTokens;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 256) return DEFAULT_CONTEXT_COMPRESSION_MAX_OUTPUT_TOKENS;
  return Math.floor(value);
}

function getToolResultInitialMaxChars(config: Config): number {
  const value = config.toolResultInitialMaxChars;
  if (!Number.isFinite(value) || value < MIN_TOOL_RESULT_CHAR_LIMIT) return DEFAULT_TOOL_RESULT_INITIAL_MAX_CHARS;
  return Math.floor(value);
}

function compressPrompt(maxChars: number): string {
  return `请更新以下会话摘要，保留关键事实、决策、结论、文件/API 和未完成事项，省略重复过程。用中文输出，不超过 ${maxChars} 字。只输出摘要。`;
}

function markerFor(message: Message): string | undefined {
  const text = typeof message.content === "string"
    ? message.content
    : message.content[0]?.type === "text" ? message.content[0].text : "";
  if (text.startsWith(SESSION_SUMMARY_MARKER)) return SESSION_SUMMARY_MARKER;
  if (text.startsWith(LEGACY_HISTORY_SUMMARY_MARKER)) return LEGACY_HISTORY_SUMMARY_MARKER;
  return undefined;
}

function summaryContent(message: Message): string {
  const text = typeof message.content === "string"
    ? message.content
    : message.content[0]?.type === "text" ? message.content[0].text : "";
  const marker = markerFor(message);
  return marker ? text.slice(marker.length).trim() : "";
}

function normalizePreviousMessages(previousMessages: Message[]): { summary: string; rawMessages: Message[] } {
  let sessionSummary = "";
  let legacySummary = "";
  const rawMessages: Message[] = [];
  for (const message of previousMessages) {
    const marker = markerFor(message);
    if (marker === SESSION_SUMMARY_MARKER) sessionSummary = summaryContent(message);
    else if (marker === LEGACY_HISTORY_SUMMARY_MARKER) legacySummary = summaryContent(message);
    else rawMessages.push(message);
  }
  return { summary: sessionSummary || legacySummary, rawMessages };
}

function summaryMessage(summary: string): Message[] {
  return summary.trim()
    ? [{ role: "user", content: `${SESSION_SUMMARY_MARKER}\n${summary.trim()}` }]
    : [];
}

function truncateSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  const omission = "\n...[摘要已截断]...\n";
  if (maxChars <= omission.length) return summary.slice(0, maxChars);
  const tailChars = Math.min(Math.floor(maxChars * 0.4), maxChars - omission.length);
  const headChars = maxChars - tailChars - omission.length;
  return `${summary.slice(0, headChars)}${omission}${summary.slice(-tailChars)}`;
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
    clamped = messages.map((message) => typeof message.content === "string" ? message : {
      ...message,
      content: message.content.map((block) => block.type === "tool_result"
        ? { ...block, content: truncateToolResultContent(block.content, limit) }
        : block),
    });
    if (estimateTokens(clamped) <= budgetTokens) return clamped;
    limit = Math.floor(limit / 2);
  }
  return clamped;
}

function messageToCompressionText(message: Message, toolResultMaxChars: number): string {
  if (typeof message.content === "string") return `[${message.role}]: ${message.content}`;
  const parts = message.content.map((block) => {
    if (block.type === "text") return `[文本]: ${block.text}`;
    if (block.type === "tool_use") return `[工具调用 ${block.name}]: ${JSON.stringify(block.input)}`;
    if (block.type === "tool_result") return `[工具结果]: ${block.content.slice(0, toolResultMaxChars)}`;
    if (block.type === "image") return `[图片]: ${block.name}`;
    return "";
  });
  return `[${message.role}]: ${parts.filter(Boolean).join(" | ")}`;
}

export async function compressMessages(
  messages: Message[],
  ctx: HookContext,
  existingSummary = "",
): Promise<Message[]> {
  const maxChars = getCompressionMaxChars(ctx.config);
  const toolResultMaxChars = getCompressionToolResultMaxChars(ctx.config);
  const text = messages.map((message) => messageToCompressionText(message, toolResultMaxChars)).join("\n");
  const prompt = `${compressPrompt(maxChars)}\n\n已有会话摘要：\n${existingSummary || "暂无"}\n\n新增上下文：\n${text}`;
  try {
    const summary = await ctx.client.complete(
      [{ role: "user", content: prompt }],
      "你是一个对话摘要助手，只输出摘要，不要有任何额外说明。",
      { maxTokens: getCompressionMaxOutputTokens(ctx.config) },
    );
    return summaryMessage(truncateSummary(summary.trim(), maxChars));
  } catch {
    return [];
  }
}

function takeRecentUserTurns(messages: Message[], count: number): Message[] {
  if (count <= 0) return [];
  let turns = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== "user") continue;
    turns++;
    startIndex = index;
    if (turns >= count) break;
  }
  return messages.slice(startIndex);
}

function latestTimestamp(messages: Message[]): number | undefined {
  const timestamps = messages
    .map((message) => message._timestamp)
    .filter((value): value is number => typeof value === "number");
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

export const coreCompressPlugin: Plugin = {
  name: "core-compress",
  async init(pluginCtx) {
    pluginCtx.registerHooks({
      onBeforeModelCall: async (hookCtx: HookContext, modelContext: ModelCallContext) => {
        const previousMessages = modelContext.messages.slice(0, modelContext.turnStartIndex);
        const currentMessages = modelContext.messages.slice(modelContext.turnStartIndex);
        const normalized = normalizePreviousMessages(previousMessages);
        const persisted = loadSessionState(pluginCtx.workspacePath, hookCtx.sessionId);
        let summary = persisted.summary || normalized.summary;
        let rawPrevious = normalized.rawMessages;
        const initialMaxChars = getToolResultInitialMaxChars(hookCtx.config);
        const beforeTokens = estimateTokens([...summaryMessage(summary), ...rawPrevious, ...currentMessages]);
        let compressionStarted = false;

        let candidate = clampToolResults(
          [...summaryMessage(summary), ...rawPrevious, ...currentMessages],
          modelContext.messageTokenBudget,
          initialMaxChars,
        );
        if (estimateTokens(candidate) <= modelContext.messageTokenBudget) {
          return {
            ...modelContext,
            messages: candidate,
            turnStartIndex: candidate.length - currentMessages.length,
          };
        }

        const through = persisted.summaryThroughTimestamp ?? 0;
        const unsummarized = rawPrevious.filter((message) => (
          typeof message._timestamp !== "number" || message._timestamp > through
        ));
        if (unsummarized.length > 0) {
          compressionStarted = true;
          modelContext.reportStatus?.({
            stage: "context_compression",
            state: "started",
            message: "正在压缩上下文…",
            beforeTokens,
          });
          const compressed = await compressMessages(unsummarized, hookCtx, summary);
          if (compressed.length > 0) {
            summary = summaryContent(compressed[0]);
            const summarizedThroughTimestamp = latestTimestamp(unsummarized) ?? through;
            updateSessionState(pluginCtx.workspacePath, hookCtx.sessionId, (state) => ({
              sessionId: hookCtx.sessionId,
              summary,
              summaryThroughTimestamp: summarizedThroughTimestamp,
              pendingMessages: state.pendingMessages.filter((message) => (
                typeof message._timestamp !== "number" || message._timestamp > summarizedThroughTimestamp
              )),
              turnsSinceSummary: 0,
              autoMemory: state.autoMemory,
            }));
          } else {
            modelContext.reportStatus?.({
              stage: "context_compression",
              state: "failed",
              message: "上下文压缩失败，正在检查请求是否仍可继续",
              beforeTokens,
            });
            pluginCtx.log("WARN", "上下文压缩模型调用失败，保留原始合法消息并执行预算检查", hookCtx.sessionId);
            return {
              ...modelContext,
              messages: candidate,
              turnStartIndex: candidate.length - currentMessages.length,
            };
          }
        }

        for (let recentTurns = getRecentTurns(hookCtx.config); recentTurns >= 0; recentTurns--) {
          const recentPrevious = takeRecentUserTurns(rawPrevious, recentTurns);
          candidate = clampToolResults(
            [...summaryMessage(summary), ...recentPrevious, ...currentMessages],
            modelContext.messageTokenBudget,
            initialMaxChars,
          );
          if (estimateTokens(candidate) <= modelContext.messageTokenBudget) {
            if (compressionStarted) {
              modelContext.reportStatus?.({
                stage: "context_compression",
                state: "completed",
                message: "上下文压缩完成，正在调用模型…",
                beforeTokens,
                afterTokens: estimateTokens(candidate),
              });
            }
            return {
              ...modelContext,
              messages: candidate,
              turnStartIndex: candidate.length - currentMessages.length,
            };
          }
        }

        // 当前轮始终完整保留；若仍超限，由 Agent 的最终预算检查明确终止本轮。
        rawPrevious = [];
        candidate = clampToolResults(
          [...summaryMessage(summary), ...currentMessages],
          modelContext.messageTokenBudget,
          initialMaxChars,
        );
        if (compressionStarted) {
          modelContext.reportStatus?.({
            stage: "context_compression",
            state: "completed",
            message: "上下文压缩完成，正在调用模型…",
            beforeTokens,
            afterTokens: estimateTokens(candidate),
          });
        }
        return {
          ...modelContext,
          messages: candidate,
          turnStartIndex: candidate.length - currentMessages.length,
        };
      },
    });
  },
};
