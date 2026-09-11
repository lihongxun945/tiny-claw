import type { Plugin } from "../types.js";
import { recallSessionHistory } from "../../session-memory/recall.js";
import { readSessionMessages } from "../../session-store.js";
import { toolContextOptions } from "../../tool-context.js";
import { estimateTextTokens } from "../../estimate-tokens.js";
import { loadConfig } from "../../config.js";

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
          tool_call_id: { type: "string", description: "contentRef.toolCallId，定位当前会话完整工具结果" },
          result_index: { type: "integer", minimum: 0, description: "搜索结果中的 resultIndex，读取对应正文" },
          offset: { type: "integer", minimum: 0, description: "字符位置，使用上次 nextOffset 继续读取" },
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
          if (typeof args.tool_call_id === "string") {
            const messages = readSessionMessages(ctx.workspacePath, toolContext.sessionId);
            const block = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
              .find(block => block.type === "tool_result" && block.tool_use_id === args.tool_call_id);
            if (!block || block.type !== "tool_result") throw new Error("当前会话没有此工具结果");
            let content = block.content;
            if (args.result_index !== undefined) {
              if (!Number.isInteger(args.result_index) || Number(args.result_index) < 0) throw new Error("result_index 必须是非负整数");
              const result = JSON.parse(content).results?.[Number(args.result_index)];
              if (typeof result?.snippet !== "string") throw new Error("没有对应的搜索正文");
              content = result.snippet;
            }
            if (args.offset !== undefined && (!Number.isInteger(args.offset) || Number(args.offset) < 0)) throw new Error("offset 必须是非负整数");
            let offset = Math.min(Number(args.offset ?? 0), content.length);
            if (query) {
              offset = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), offset);
              if (offset < 0) return JSON.stringify({ matched: false, toolCallId: args.tool_call_id });
            }
            const budget = toolContextOptions(toolContext.config ?? loadConfig(ctx.workspacePath)).readMaxTokens;
            const render = (length: number) => JSON.stringify({ toolCallId: args.tool_call_id,
              resultIndex: args.result_index, offset, nextOffset: offset + length,
              totalChars: content.length, truncated: offset + length < content.length,
              content: content.slice(offset, offset + length) });
            let low = 0;
            let high = content.length - offset;
            let best = render(0);
            while (low <= high) {
              const size = Math.floor((low + high) / 2);
              const candidate = render(size);
              if (estimateTextTokens(candidate) <= budget) { best = candidate; low = size + 1; }
              else high = size - 1;
            }
            return best;
          }
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
