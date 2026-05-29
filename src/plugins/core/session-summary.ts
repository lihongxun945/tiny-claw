import type { Plugin, HookContext } from "../types.js";
import type { ChatResponse, ContentBlock, Message, ToolUseBlock } from "../../types.js";

const SUMMARY_MARKER = "[当前会话摘要]";
const DEFAULT_RECENT_TURNS = 3;
const DEFAULT_TURN_THRESHOLD = 5;
const DEFAULT_MAX_CHARS = 4000;

const UPDATE_SUMMARY_PROMPT = `请更新当前会话的滚动摘要。

要求：
- 保留用户目标、关键事实、已完成事项、重要决策、涉及的文件/API、未完成事项。
- 工具结果只保留关键信息，不要复制大段原文。
- 删除闲聊、重复过程和无用中间输出。
- 用中文输出，结构清晰，尽量简洁。
- 不要输出额外解释，只输出新的摘要。`;

interface SessionState {
  summary: string;
  pendingMessages: Message[];
  turnsSinceSummary: number;
}

function isEnabled(ctx: HookContext): boolean {
  return ctx.config.sessionSummary?.enabled !== false;
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
  return { role: "assistant", content };
}

function hasSummaryMarker(message: Message): boolean {
  if (typeof message.content === "string") {
    return message.content.startsWith(SUMMARY_MARKER);
  }
  const first = message.content[0];
  return first?.type === "text" && first.text.startsWith(SUMMARY_MARKER);
}

function stripSummaryMessages(messages: Message[], turnStartIndex: number): { messages: Message[]; turnStartIndex: number } {
  const stripped: Message[] = [];
  let removedBeforeTurn = 0;
  messages.forEach((message, index) => {
    if (hasSummaryMarker(message)) {
      if (index < turnStartIndex) removedBeforeTurn++;
      return;
    }
    stripped.push(message);
  });
  return {
    messages: stripped,
    turnStartIndex: Math.max(0, turnStartIndex - removedBeforeTurn),
  };
}

function withSummaryMessage(summary: string, messages: Message[]): Message[] {
  const summaryText = `${SUMMARY_MARKER}\n${summary.trim()}`;
  if (!summary.trim()) return messages;
  if (messages.length === 0) return [{ role: "user", content: summaryText }];

  const [first, ...rest] = messages;
  if (first.role === "user") {
    if (typeof first.content === "string") {
      return [{ ...first, content: `${summaryText}\n\n${first.content}` }, ...rest];
    }
    return [{
      ...first,
      content: [{ type: "text", text: summaryText }, ...first.content],
    }, ...rest];
  }

  return [{ role: "user", content: summaryText }, ...messages];
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[已截断]` : text;
}

export const coreSessionSummaryPlugin: Plugin = {
  name: "core-session-summary",
  async init(ctx) {
    const states = new Map<string, SessionState>();

    ctx.registerHooks({
      onBeforeModelCall: (hookCtx: HookContext, messages: Message[]) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return messages;

        const stripped = stripSummaryMessages(messages, hookCtx.turnStartIndex);
        const previousMessages = stripped.messages.slice(0, stripped.turnStartIndex);
        const currentMessages = stripped.messages.slice(stripped.turnStartIndex);
        const state = states.get(hookCtx.sessionId) ?? { summary: "", pendingMessages: [], turnsSinceSummary: 0 };

        if (!state.summary) {
          states.set(hookCtx.sessionId, state);
          return stripped.messages.length === messages.length ? messages : stripped.messages;
        }

        const maxPrevious = getRecentTurns(hookCtx) * 2;
        let recentPrevious = state.pendingMessages.length > 0
          ? state.pendingMessages
          : previousMessages.slice(-maxPrevious);

        if (recentPrevious.length > 0 && recentPrevious[0].role === "assistant") {
          recentPrevious = recentPrevious.slice(1);
        }

        const cleanContext = [...recentPrevious, ...currentMessages];
        states.set(hookCtx.sessionId, state);

        return withSummaryMessage(state.summary, cleanContext);
      },

      onChatResponse: async (hookCtx: HookContext, response: ChatResponse) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return response;
        if (response.toolCalls.length > 0) return response;

        const state = states.get(hookCtx.sessionId) ?? { summary: "", pendingMessages: [], turnsSinceSummary: 0 };
        const currentTurnMessages = stripSummaryMessages(
          hookCtx.history.getCurrentTurnMessages(),
          0,
        ).messages;
        state.pendingMessages.push(...currentTurnMessages, responseToMessage(response));
        state.turnsSinceSummary += 1;
        states.set(hookCtx.sessionId, state);

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
          states.set(hookCtx.sessionId, state);
        } catch {
          // 摘要失败不应影响主回答。
        }

        return response;
      },
    });
  },
};
