import type { Plugin } from "../types.js";
import { recallSessionHistory } from "../../session-memory/recall.js";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const DEFAULT_MAX_QUERY_CHARS = 500;

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export const coreSessionRecallPlugin: Plugin = {
  name: "core-session-recall",
  async init(ctx) {
    ctx.registerTool({
      name: "session_history_recall",
      description: "从当前会话的持久化原始历史中精确取回消息。需要核对摘要来源、引用旧消息原文或恢复被压缩细节时使用",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          message_ids: { type: "array", items: { type: "string" }, description: "摘要 sources 中的 messageId 列表" },
          from_sequence: { type: "number", description: "可选起始消息序号（含）" },
          to_sequence: { type: "number", description: "可选结束消息序号（含）" },
          query: { type: "string", description: "可选原文关键词，大小写不敏感" },
          limit: { type: "number", description: "可选最大返回条数" },
        },
      },
      async execute(args, toolContext) {
        if (!toolContext?.sessionId) return JSON.stringify({ error: "缺少当前 sessionId" });
        const config = toolContext.config?.sessionSummary;
        const maxResults = positiveInt(config?.recallMaxResults, DEFAULT_MAX_RESULTS);
        const maxOutputChars = positiveInt(config?.recallMaxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
        const maxQueryChars = positiveInt(config?.recallMaxQueryChars, DEFAULT_MAX_QUERY_CHARS);
        const messageIds = Array.isArray(args.message_ids)
          ? args.message_ids.filter((value): value is string => typeof value === "string")
          : undefined;
        const query = typeof args.query === "string" ? args.query.trim() : undefined;
        if (query && query.length > maxQueryChars) {
          return JSON.stringify({ error: `query 不能超过 ${maxQueryChars} 字符` });
        }
        const fromSequence = optionalPositiveInt(args.from_sequence);
        const toSequence = optionalPositiveInt(args.to_sequence);
        if (args.from_sequence !== undefined && fromSequence === undefined) {
          return JSON.stringify({ error: "from_sequence 必须是正整数" });
        }
        if (args.to_sequence !== undefined && toSequence === undefined) {
          return JSON.stringify({ error: "to_sequence 必须是正整数" });
        }
        if (fromSequence !== undefined && toSequence !== undefined && fromSequence > toSequence) {
          return JSON.stringify({ error: "from_sequence 不能大于 to_sequence" });
        }
        const requestedLimit = optionalPositiveInt(args.limit) ?? maxResults;
        try {
          return JSON.stringify(recallSessionHistory(ctx.workspacePath, toolContext.sessionId, {
            messageIds,
            fromSequence,
            toSequence,
            query,
            limit: Math.min(requestedLimit, maxResults),
            maxOutputChars,
          }));
        } catch (error) {
          return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  },
};

function optionalPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
