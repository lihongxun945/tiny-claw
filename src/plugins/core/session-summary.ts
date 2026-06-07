import type { Plugin, HookContext } from "../types.js";
import type { ChatResponse, ContentBlock, Message, ToolUseBlock } from "../../types.js";
import { stripToolMessagesForNewTurn } from "../../message-sanitizer.js";
import { loadSessionState, saveSessionState, type SessionStateInput } from "../../session-state.js";

const SUMMARY_MARKER = "[当前会话摘要]";
const DEFAULT_RECENT_TURNS = 3;
const DEFAULT_TURN_THRESHOLD = 5;
const DEFAULT_MAX_CHARS = 4000;

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

function getMaxChars(ctx: HookContext): number {
  const value = ctx.config.sessionSummary?.maxChars;
  if (!Number.isFinite(value) || !value || value < 500) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(value), 20000);
}

function blockToText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") return `[工具调用 ${block.name}]: ${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return `[工具结果]: ${block.content.slice(0, 1200)}`;
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

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[已截断]` : text;
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
        pendingMessages: state.pendingMessages,
        turnsSinceSummary: state.turnsSinceSummary,
        updatedAt: state.updatedAt,
      };
    }

    function isNewer(updatedAt: string | undefined, currentUpdatedAt: string | undefined): boolean {
      return Date.parse(updatedAt ?? "") > Date.parse(currentUpdatedAt ?? "");
    }

    function getState(hookCtx: HookContext): CachedSessionState {
      const existing = states.get(hookCtx.sessionId);
      if (existing) {
        if (isPersistent(hookCtx)) {
          const loaded = loadSessionState(ctx.workspacePath, hookCtx.sessionId);
          if (isNewer(loaded.updatedAt, existing.updatedAt)) {
            const refreshed = fromPersistedState(loaded);
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
        next.updatedAt = saveSessionState(ctx.workspacePath, state).updatedAt;
      }
      states.set(hookCtx.sessionId, next);
    }

    ctx.registerHooks({
      onBeforeModelCall: (hookCtx: HookContext, messages: Message[]) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return messages;

        const stripped = stripSummaryMessages(messages, hookCtx.turnStartIndex);
        const previousMessages = stripped.messages.slice(0, stripped.turnStartIndex);
        const currentMessages = stripped.messages.slice(stripped.turnStartIndex);
        const state = getState(hookCtx);

        if (!state.summary) {
          return stripped.messages.length === messages.length ? messages : stripped.messages;
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

        return withSummaryMessage(state.summary, cleanContext);
      },

      onChatResponse: async (hookCtx: HookContext, response: ChatResponse) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return response;
        if (response.toolCalls.length > 0) return response;

        const state = getState(hookCtx);
        const currentTurnMessages = stripSummaryMessages(
          hookCtx.history.getCurrentTurnMessages(),
          0,
        ).messages;
        state.pendingMessages.push(...currentTurnMessages, responseToMessage(response));
        state.turnsSinceSummary += 1;
        putState(hookCtx, state);

        if (state.turnsSinceSummary < getTurnThreshold(hookCtx)) {
          return response;
        }

        const newMessages = [...state.pendingMessages];
        const text = newMessages.map(messageToText).join("\n");
        const existingSummary = state.summary || "暂无";
        const prompt = `${UPDATE_SUMMARY_PROMPT}

已有会话摘要：
${existingSummary}

本次新增上下文：
${truncateText(text, getMaxChars(hookCtx))}`;

        try {
          const summary = await hookCtx.client.complete(
            [{ role: "user", content: prompt }],
            "你是会话状态摘要器。只输出新的会话摘要，不要输出解释。",
          );
          state.summary = truncateText(summary.trim(), getMaxChars(hookCtx));
          state.pendingMessages = [];
          state.turnsSinceSummary = 0;
          putState(hookCtx, state);
        } catch {
          // 摘要失败不应影响主回答。
        }

        return response;
      },
    });
  },
};
