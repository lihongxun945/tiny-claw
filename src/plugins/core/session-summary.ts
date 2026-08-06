import type { Plugin, HookContext } from "../types.js";
import type { ChatResponse, ContentBlock, Message, ToolUseBlock } from "../../types.js";
import { stripToolMessagesForNewTurn } from "../../message-sanitizer.js";
import { loadSessionState, updateSessionState, type SessionStateInput } from "../../session-state.js";

const SUMMARY_MARKER = "[当前会话摘要]";
const DEFAULT_RECENT_TURNS = 3;
const DEFAULT_TURN_THRESHOLD = 5;
const DEFAULT_MAX_INPUT_CHARS = 40000; // 摘要输入（本次新增上下文）字符上限
const DEFAULT_MAX_CHARS = 10000; // 摘要存储字符上限（输出）
const DEFAULT_SUMMARY_MAX_TOKENS = 10000; // LLM 摘要输出 token 上限
// 工具结果/输入进入摘要输入时的裁剪上限（避免噪音霸占预算）
const TOOL_RESULT_MAX_CHARS = 300;
const TOOL_INPUT_MAX_CHARS = 200;

interface CachedSessionState extends SessionStateInput {
  updatedAt?: string;
}

const UPDATE_SUMMARY_PROMPT = `请更新当前会话的滚动摘要。

要求：
- 保留用户目标、关键事实、已完成事项、重要决策、涉及的文件/API、未完成事项。
- 工具结果只保留关键信息，不要复制大段原文。
- 删除闲聊、重复过程和无用中间输出。
- 用中文输出，结构清晰，尽量简洁。
- 不要输出额外解释，只输出新的摘要。`;

function isEnabled(ctx: HookContext): boolean {
  return ctx.config.sessionSummary?.enabled !== false;
}

function isPersistent(ctx: HookContext): boolean {
  return ctx.config.sessionSummary?.persistent !== false;
}

function isSubAgentSession(sessionId: string): boolean {
  return sessionId.startsWith("sub:");
}

function getRecentTurns(ctx: HookContext): number {
  const value = ctx.config.sessionSummary?.recentTurns;
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_RECENT_TURNS;
  return Math.min(Math.floor(value), 20);
}

function getTurnThreshold(ctx: HookContext): number {
  const value = ctx.config.sessionSummary?.turnThreshold;
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_TURN_THRESHOLD;
  return Math.min(Math.floor(value), 100);
}

function getMaxInputChars(ctx: HookContext): number {
  const value = ctx.config.sessionSummary?.maxInputChars;
  if (!Number.isFinite(value) || !value || value < 1000) return DEFAULT_MAX_INPUT_CHARS;
  return Math.min(Math.floor(value), 200000);
}

function getMaxChars(ctx: HookContext): number {
  const value = ctx.config.sessionSummary?.maxChars;
  if (!Number.isFinite(value) || !value || value < 500) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(value), 100000);
}

function getSummaryMaxTokens(ctx: HookContext): number {
  const value = ctx.config.sessionSummary?.maxOutputTokens;
  if (!Number.isFinite(value) || !value || value < 256) return DEFAULT_SUMMARY_MAX_TOKENS;
  return Math.min(Math.floor(value), 20000);
}

function blockToText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") {
    const input = JSON.stringify(block.input);
    const clipped = input.length > TOOL_INPUT_MAX_CHARS
      ? `${input.slice(0, TOOL_INPUT_MAX_CHARS)}…[省略 ${input.length - TOOL_INPUT_MAX_CHARS} 字符]`
      : input;
    return `[工具调用 ${block.name}]: ${clipped}`;
  }
  if (block.type === "tool_result") {
    const content = block.content;
    const clipped = content.length > TOOL_RESULT_MAX_CHARS
      ? `${content.slice(0, TOOL_RESULT_MAX_CHARS)}…[省略 ${content.length - TOOL_RESULT_MAX_CHARS} 字符]`
      : content;
    return `[工具结果]: ${clipped}`;
  }
  if (block.type === "image") return `[图片附件]: ${block.name}`;
  return "";
}

function messageToText(message: Message): string {
  if (typeof message.content === "string") {
    return `[${message.role}]: ${message.content}`;
  }
  return `[${message.role}]: ${message.content.map(blockToText).filter(Boolean).join(" | ")}`;
}

function responseToMessage(response: ChatResponse): Message {
  const content: Array<ToolUseBlock | { type: "text"; text: string }> = [];
  if (response.text.trim()) {
    content.push({ type: "text", text: response.text });
  }
  content.push(...response.toolCalls);
  return { role: "assistant", content, _timestamp: Date.now() };
}

function stripSummaryMarker(message: Message): Message | undefined {
  if (typeof message.content === "string") {
    if (!message.content.startsWith(SUMMARY_MARKER)) return message;
    const rest = message.content.split("\n\n").slice(1).join("\n\n").trimStart();
    return rest ? { ...message, content: rest } : undefined;
  }

  const [first, ...restBlocks] = message.content;
  if (first?.type !== "text" || !first.text.startsWith(SUMMARY_MARKER)) return message;

  const restText = first.text.split("\n\n").slice(1).join("\n\n").trimStart();
  const content = [
    ...(restText ? [{ type: "text" as const, text: restText }] : []),
    ...restBlocks,
  ];
  return content.length > 0 ? { ...message, content } : undefined;
}

function stripSummaryMessages(messages: Message[], turnStartIndex: number): { messages: Message[]; turnStartIndex: number } {
  const stripped: Message[] = [];
  let removedBeforeTurn = 0;
  messages.forEach((message, index) => {
    const clean = stripSummaryMarker(message);
    if (!clean) {
      if (index < turnStartIndex) removedBeforeTurn++;
      return;
    }
    stripped.push(clean);
  });
  return {
    messages: stripped,
    turnStartIndex: Math.max(0, turnStartIndex - removedBeforeTurn),
  };
}

function withSummaryMessage(summary: string, messages: Message[]): Message[] {
  const summaryText = `${SUMMARY_MARKER}\n${summary.trim()}`;
  if (!summary.trim()) return messages;
  return [{ role: "user", content: summaryText }, ...messages];
}

/**
 * 文本截断：超过上限时保留**尾部**（最新内容），头部标注省略。
 * 滚动摘要的输入是时间序追加的，最新进展在末尾，若用 slice(0, max) 会丢掉最新信息。
 */
function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `...[旧内容已省略，仅保留最近 ${maxChars} 字符]\n${text.slice(-maxChars)}`
    : text;
}

function messageKey(message: Message): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    timestamp: message._timestamp,
  });
}

function mergeRecentMessages(
  historyMessages: Message[],
  pendingMessages: Message[],
  recentTurns: number,
): Message[] {
  const merged: Message[] = [];
  const seen = new Set<string>();
  const latestHistoryTimestamp = Math.max(
    0,
    ...historyMessages
      .map((message) => message._timestamp)
      .filter((timestamp): timestamp is number => typeof timestamp === "number"),
  );
  const pendingToMerge = pendingMessages.filter((message) => {
    if (typeof message._timestamp === "number") return message._timestamp > latestHistoryTimestamp;
    return historyMessages.length < recentTurns * 2;
  });

  for (const message of stripToolMessagesForNewTurn([...historyMessages, ...pendingToMerge])) {
    const key = messageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }

  return takeRecentUserTurns(merged, recentTurns);
}

function takeRecentUserTurns(messages: Message[], recentTurns: number): Message[] {
  let userTurns = 0;
  let startIndex = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== "user") continue;
    userTurns++;
    startIndex = index;
    if (userTurns >= recentTurns) break;
  }

  return messages.slice(startIndex);
}

export const coreSessionSummaryPlugin: Plugin = {
  name: "core-session-summary",
  async init(ctx) {
    const states = new Map<string, CachedSessionState>();

    function fromPersistedState(state: ReturnType<typeof loadSessionState>): CachedSessionState {
      return {
        sessionId: state.sessionId,
        summary: state.summary,
        summaryThroughTimestamp: state.summaryThroughTimestamp,
        pendingMessages: state.pendingMessages,
        turnsSinceSummary: state.turnsSinceSummary,
        updatedAt: state.updatedAt,
      };
    }

    function shouldRefresh(loaded: CachedSessionState, current: CachedSessionState): boolean {
      const loadedTime = Date.parse(loaded.updatedAt ?? "");
      const currentTime = Date.parse(current.updatedAt ?? "");
      if (loadedTime > currentTime) return true;
      if (loadedTime < currentTime) return false;
      return loaded.summary !== current.summary
        || loaded.turnsSinceSummary !== current.turnsSinceSummary
        || loaded.summaryThroughTimestamp !== current.summaryThroughTimestamp
        || JSON.stringify(loaded.pendingMessages) !== JSON.stringify(current.pendingMessages);
    }

    function getState(hookCtx: HookContext): CachedSessionState {
      const existing = states.get(hookCtx.sessionId);
      if (existing) {
        if (isPersistent(hookCtx)) {
          const loaded = loadSessionState(ctx.workspacePath, hookCtx.sessionId);
          const refreshed = fromPersistedState(loaded);
          if (shouldRefresh(refreshed, existing)) {
            states.set(hookCtx.sessionId, refreshed);
            return refreshed;
          }
        }
        return existing;
      }

      const state = isPersistent(hookCtx)
        ? fromPersistedState(loadSessionState(ctx.workspacePath, hookCtx.sessionId))
        : { sessionId: hookCtx.sessionId, summary: "", pendingMessages: [], turnsSinceSummary: 0 };
      states.set(hookCtx.sessionId, state);
      return state;
    }

    function putState(hookCtx: HookContext, state: CachedSessionState): void {
      const next = { ...state };
      if (isPersistent(hookCtx)) {
        next.updatedAt = updateSessionState(ctx.workspacePath, state.sessionId, (latest) => ({
          sessionId: state.sessionId,
          summary: state.summary,
          summaryThroughTimestamp: state.summaryThroughTimestamp,
          pendingMessages: state.pendingMessages,
          turnsSinceSummary: state.turnsSinceSummary,
          autoMemory: latest.autoMemory,
        })).updatedAt;
      }
      states.set(hookCtx.sessionId, next);
    }

    async function recordCompletedTurn(
      hookCtx: HookContext,
      messages: Message[],
    ): Promise<void> {
      const state = getState(hookCtx);
      state.pendingMessages.push(...messages);
      state.turnsSinceSummary += 1;
      putState(hookCtx, state);

      if (state.turnsSinceSummary < getTurnThreshold(hookCtx)) return;

      const text = state.pendingMessages.map(messageToText).join("\n");
      const existingSummary = state.summary || "暂无";
      const prompt = `${UPDATE_SUMMARY_PROMPT}

已有会话摘要：
${existingSummary}

本次新增上下文：
${truncateText(text, getMaxInputChars(hookCtx))}`;

      try {
        const summary = await hookCtx.client.complete(
          [{ role: "user", content: prompt }],
          "你是会话状态摘要器。只输出新的会话摘要，不要输出解释。",
          { maxTokens: getSummaryMaxTokens(hookCtx) },
        );
        state.summary = truncateText(summary.trim(), getMaxChars(hookCtx));
        state.summaryThroughTimestamp = Math.max(
          state.summaryThroughTimestamp ?? 0,
          ...state.pendingMessages
            .map((message) => message._timestamp)
            .filter((timestamp): timestamp is number => typeof timestamp === "number"),
        );
        state.pendingMessages = [];
        state.turnsSinceSummary = 0;
        putState(hookCtx, state);
      } catch {
        // 摘要失败不应影响主回答；退避重试间隔（保留 pendingMessages），避免每轮重复请求。
        state.turnsSinceSummary = Math.max(1, Math.floor(state.turnsSinceSummary / 2));
        putState(hookCtx, state);
      }
    }

    ctx.registerHooks({
      onBeforeModelCall: (hookCtx: HookContext, modelContext) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return modelContext;

        const messages = modelContext.messages;

        const stripped = stripSummaryMessages(messages, hookCtx.turnStartIndex);
        const previousMessages = stripped.messages.slice(0, stripped.turnStartIndex);
        const currentMessages = stripped.messages.slice(stripped.turnStartIndex);
        const state = getState(hookCtx);

        if (!state.summary) {
          return stripped.messages.length === messages.length
            ? modelContext
            : { ...modelContext, messages: stripped.messages, turnStartIndex: stripped.turnStartIndex };
        }

        const recentTurns = getRecentTurns(hookCtx);
        let recentPrevious = mergeRecentMessages(
          previousMessages,
          state.pendingMessages,
          recentTurns,
        );

        if (recentPrevious.length > 0 && recentPrevious[0].role === "assistant") {
          recentPrevious = recentPrevious.slice(1);
        }

        const cleanContext = [...recentPrevious, ...currentMessages];

        const summarizedMessages = withSummaryMessage(state.summary, cleanContext);
        return {
          ...modelContext,
          messages: summarizedMessages,
          turnStartIndex: summarizedMessages.length - currentMessages.length,
        };
      },

      onChatResponse: async (hookCtx: HookContext, response: ChatResponse) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return response;
        if (response.toolCalls.length > 0) return response;

        const currentTurnMessages = stripSummaryMessages(
          hookCtx.history.getCurrentTurnMessages(),
          0,
        ).messages;
        await recordCompletedTurn(hookCtx, [...currentTurnMessages, responseToMessage(response)]);

        return response;
      },

      onTurnEnd: async (hookCtx, reason) => {
        if (reason !== "iteration_limit" || !isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return;
        const currentTurnMessages = stripToolMessagesForNewTurn(
          stripSummaryMessages(hookCtx.history.getCurrentTurnMessages(), 0).messages,
        );
        await recordCompletedTurn(hookCtx, currentTurnMessages);
      },
    });
  },
};
