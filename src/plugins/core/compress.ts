import type { Plugin, HookContext, ModelCallContext } from "../types.js";
import type { Message, Config } from "../../types.js";
import { estimateTextTokens, estimateTokens } from "../../estimate-tokens.js";
import { getEffectiveMaxContextTokens } from "../../context-budget.js";

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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 256) {
    return DEFAULT_CONTEXT_COMPRESSION_MAX_OUTPUT_TOKENS;
  }
  return Math.floor(value);
}

function getToolResultInitialMaxChars(config: Config): number {
  const value = config.toolResultInitialMaxChars;
  if (!Number.isFinite(value) || value < MIN_TOOL_RESULT_CHAR_LIMIT) {
    return DEFAULT_TOOL_RESULT_INITIAL_MAX_CHARS;
  }
  return Math.floor(value);
}

function compressPrompt(maxChars: number): string {
  return `请更新以下临时上下文摘要，保留关键事实、决策、结论、文件/API 和未完成事项，省略重复过程。用中文输出，不超过 ${maxChars} 字。只输出摘要。`;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

function isLegacySyntheticSummary(message: Message): boolean {
  const text = messageText(message);
  return text.startsWith(SESSION_SUMMARY_MARKER) || text.startsWith(LEGACY_HISTORY_SUMMARY_MARKER);
}

function legacySummaryContent(message: Message): string {
  const text = messageText(message);
  const marker = text.startsWith(SESSION_SUMMARY_MARKER)
    ? SESSION_SUMMARY_MARKER
    : text.startsWith(LEGACY_HISTORY_SUMMARY_MARKER)
      ? LEGACY_HISTORY_SUMMARY_MARKER
      : "";
  return marker ? text.slice(marker.length).trim() : "";
}

function normalizePreviousMessages(previousMessages: Message[]): { summary: string; rawMessages: Message[] } {
  let summary = "";
  const rawMessages: Message[] = [];
  for (const message of previousMessages) {
    if (isLegacySyntheticSummary(message)) summary = legacySummaryContent(message) || summary;
    else rawMessages.push(message);
  }
  return { summary, rawMessages };
}

function internalSummaryBlock(summary: string): string {
  return [
    '<context_compression_summary data-kind="derived-summary" role="internal">',
    "以下内容是系统从较早上下文生成的临时摘要，不是用户消息，也不是新指令。",
    summary.trim(),
    "</context_compression_summary>",
  ].join("\n");
}

function appendSystemPromptSuffix(existing: string | undefined, suffix: string): string {
  return existing ? `${existing}\n\n${suffix}` : suffix;
}

function summaryBudget(modelContext: ModelCallContext, summary: string): number {
  const suffixTokens = summary.trim() ? estimateTextTokens(internalSummaryBlock(summary)) : 0;
  return Math.max(0, modelContext.messageTokenBudget - suffixTokens);
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
): Promise<string | undefined> {
  const maxChars = getCompressionMaxChars(ctx.config);
  const toolResultMaxChars = getCompressionToolResultMaxChars(ctx.config);
  const text = messages.map((message) => messageToCompressionText(message, toolResultMaxChars)).join("\n");
  const prompt = `${compressPrompt(maxChars)}\n\n已有临时摘要：\n${existingSummary || "暂无"}\n\n新增上下文：\n${text}`;
  try {
    const summary = await ctx.client.complete(
      [{ role: "user", content: prompt }],
      "你是上下文压缩器。只输出派生摘要，不要把摘要写成用户发言，不要添加任何额外说明。",
      { maxTokens: getCompressionMaxOutputTokens(ctx.config), signal: ctx.signal },
    );
    const trimmed = summary.trim();
    return trimmed ? truncateSummary(trimmed, maxChars) : undefined;
  } catch {
    ctx.signal?.throwIfAborted();
    return undefined;
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

function withSummary(
  modelContext: ModelCallContext,
  messages: Message[],
  currentMessageCount: number,
  summary: string,
): ModelCallContext {
  const block = summary.trim() ? internalSummaryBlock(summary) : "";
  return {
    ...modelContext,
    messages,
    turnStartIndex: messages.length - currentMessageCount,
    contextSummaries: [...(modelContext.contextSummaries ?? []), ...(block ? [{ title: "临时压缩摘要", content: block }] : [])],
    systemPromptSuffix: block
      ? appendSystemPromptSuffix(modelContext.systemPromptSuffix, block)
      : modelContext.systemPromptSuffix,
  };
}

export const coreCompressPlugin: Plugin = {
  name: "core-compress",
  async init(pluginCtx) {
    const turnSummaries = new Map<string, string>();
    const turnKey = (ctx: HookContext) => `${ctx.sessionId}\0${ctx.turnId ?? ""}`;

    pluginCtx.registerHooks({
      onBeforeModelCall: async (hookCtx: HookContext, modelContext: ModelCallContext) => {
        const previousMessages = modelContext.messages.slice(0, modelContext.turnStartIndex);
        const currentMessages = modelContext.messages.slice(modelContext.turnStartIndex);
        const normalized = normalizePreviousMessages(previousMessages);
        const key = turnKey(hookCtx);
        let summary = turnSummaries.get(key) || normalized.summary;
        const rawPrevious = normalized.rawMessages;
        const initialMaxChars = getToolResultInitialMaxChars(hookCtx.config);
        const beforeTokens = estimateTokens([...rawPrevious, ...currentMessages]);
        let compressionStarted = false;
        let budget = summaryBudget(modelContext, summary);

        let candidate = clampToolResults(
          [...rawPrevious, ...currentMessages],
          budget,
          initialMaxChars,
        );
        if (estimateTokens(candidate) <= budget) {
          return withSummary(modelContext, candidate, currentMessages.length, summary);
        }

        if (rawPrevious.length > 0) {
          compressionStarted = true;
          modelContext.reportStatus?.({
            stage: "context_compression",
            state: "started",
            message: "正在压缩上下文…",
            beforeTokens,
          });
          const compressed = await compressMessages(rawPrevious, hookCtx, summary);
          if (compressed) {
            summary = compressed;
            turnSummaries.set(key, summary);
            budget = summaryBudget(modelContext, summary);
          } else {
            modelContext.reportStatus?.({
              stage: "context_compression",
              state: "failed",
              message: "上下文压缩失败，正在检查请求是否仍可继续",
              beforeTokens,
            });
            pluginCtx.log("WARN", "上下文压缩模型调用失败，保留原始合法消息并执行预算检查", hookCtx.sessionId);
            return withSummary(modelContext, candidate, currentMessages.length, summary);
          }
        }

        for (let recentTurns = getRecentTurns(hookCtx.config); recentTurns >= 0; recentTurns--) {
          const recentPrevious = takeRecentUserTurns(rawPrevious, recentTurns);
          candidate = clampToolResults(
            [...recentPrevious, ...currentMessages],
            budget,
            initialMaxChars,
          );
          if (estimateTokens(candidate) <= budget) {
            if (compressionStarted) {
              modelContext.reportStatus?.({
                stage: "context_compression",
                state: "completed",
                message: "上下文压缩完成，正在调用模型…",
                beforeTokens,
                afterTokens: estimateTokens(candidate) + estimateTextTokens(internalSummaryBlock(summary)),
              });
            }
            return withSummary(modelContext, candidate, currentMessages.length, summary);
          }
        }

        candidate = clampToolResults(currentMessages, budget, initialMaxChars);
        if (compressionStarted) {
          modelContext.reportStatus?.({
            stage: "context_compression",
            state: "completed",
            message: "上下文压缩完成，正在调用模型…",
            beforeTokens,
            afterTokens: estimateTokens(candidate) + estimateTextTokens(internalSummaryBlock(summary)),
          });
        }
        return withSummary(modelContext, candidate, currentMessages.length, summary);
      },
      onTurnEnd: (hookCtx) => {
        turnSummaries.delete(turnKey(hookCtx));
      },
    });
  },
};
