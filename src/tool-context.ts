import type { Config, Message } from "./types.js";
import { estimateTextTokens, estimateTokens } from "./estimate-tokens.js";

export interface ToolContextOptions {
  maxResultTokens: number;
  readMaxTokens: number;
  searchSnippetChars: number;
  safetyMargin: number;
  summaryRetries: number;
  searchMaxResponseBytes: number;
}
export const TOOL_CONTEXT_DEFAULTS: ToolContextOptions = {
  maxResultTokens: 8000, readMaxTokens: 4000, searchSnippetChars: 1500,
  safetyMargin: 0.05, summaryRetries: 1, searchMaxResponseBytes: 8 * 1024 * 1024,
};
export function toolContextOptions(config: Config): ToolContextOptions {
  const raw = config.plugins?.["core-tool-context"] ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plugins.core-tool-context 必须是对象");
  const result = { ...TOOL_CONTEXT_DEFAULTS };
  for (const key of Object.keys(result) as Array<keyof ToolContextOptions>) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)
      || (key === "safetyMargin" ? value < 0 || value >= 1 : !Number.isInteger(value) || value < (key === "summaryRetries" ? 0 : 1))) {
      throw new Error(`plugins.core-tool-context.${key} 配置无效`);
    }
    result[key] = value;
  }
  return result;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parse(value: string): Record<string, unknown> | undefined {
  try { const result: unknown = JSON.parse(value); return object(result) ? result : undefined; } catch { return undefined; }
}
export function isControlResult(content: string): boolean {
  const value = parse(content);
  return value?.requiresConfirmation === true || value?.status === "waiting_user"
    || (value?.status === "answered" && Array.isArray(value.selectedIds));
}

export function boundedToolResult(content: string, toolCallId: string, maxTokens: number, snippetChars: number): string {
  if (isControlResult(content)) return content;
  const original = parse(content);
  const search = Array.isArray(original?.results) && original.results.every(r => object(r) && typeof r.snippet === "string");
  const needsSnippet = search && (original!.results as Array<Record<string, unknown>>).some(r => String(r.snippet).length > snippetChars);
  if (!needsSnippet && estimateTextTokens(content) <= maxTokens) return content;
  const metadata = { truncated: true, originalChars: content.length, contentRef: { toolCallId } };
  const render = (chars: number): string => {
    if (search) {
      return JSON.stringify({ ...metadata, results: (original!.results as Array<Record<string, unknown>>).map((r, index) => ({
        title: String(r.title ?? "").slice(0, chars), url: String(r.url ?? ""),
        snippet: String(r.snippet).slice(0, Math.min(chars, snippetChars)), resultIndex: index,
      })) });
    }
    if (original && typeof original.content === "string" && typeof original.offset === "number" && typeof original.totalChars === "number") {
      const length = Math.min(chars, original.content.length);
      return JSON.stringify({ toolCallId: original.toolCallId, resultIndex: original.resultIndex,
        offset: original.offset, nextOffset: original.offset + length, totalChars: original.totalChars,
        truncated: original.offset + length < original.totalChars, content: original.content.slice(0, length) });
    }
    return JSON.stringify({ ...metadata,
      ...(original && "exitCode" in original ? { exitCode: original.exitCode } : {}),
      ...(original && typeof original.status === "string" ? { status: original.status.slice(0, chars) } : {}),
      ...(original && typeof original.error === "string" ? { error: original.error.slice(0, chars) } : {}),
      preview: content.slice(0, chars),
    });
  };
  let low = 0;
  let high = content.length;
  let best = JSON.stringify({ ...metadata, preview: "内容已保存，请使用 session_history_recall 按片段读取。" });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);
    if (estimateTextTokens(candidate) <= maxTokens) { best = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}

/** Build a model-only projection; persisted messages and control responses remain unchanged. */
export function projectToolMessages(messages: Message[], config: Config, tokenBudget = Infinity, protectLatest = false): Message[] {
  const options = toolContextOptions(config);
  const results: Array<{ block: { content: string }; original: string; id: string; latest: boolean }> = [];
  let lastAssistant = -1;
  messages.forEach((message, index) => { if (message.role === "assistant") lastAssistant = index; });
  const projected = messages.map((message, index) => typeof message.content === "string" ? message : ({ ...message,
    content: message.content.map(block => {
      if (block.type !== "tool_result" || isControlResult(block.content)) return block;
      const copy = { ...block, content: boundedToolResult(block.content, block.tool_use_id, 0, options.searchSnippetChars) };
      results.push({ block: copy, original: block.content, id: block.tool_use_id, latest: index > lastAssistant });
      return copy;
    }),
  }));
  let remaining = tokenBudget - estimateTokens(projected);
  // Allocate actual costs newest-first, rather than starving every result equally.
  for (const result of results.reverse()) {
    const previousCost = estimateTextTokens(result.block.content);
    const available = Math.max(0, remaining + previousCost);
    const budget = Math.min(options.maxResultTokens, protectLatest && result.latest
      ? Math.max(options.readMaxTokens, available) : available);
    result.block.content = boundedToolResult(result.original, result.id, budget, options.searchSnippetChars);
    remaining -= estimateTextTokens(result.block.content) - previousCost;
  }
  return projected;
}

export function displayToolResult(content: string, toolCallId: string, sessionId: string, config: Config): string {
  const options = toolContextOptions(config);
  const preview = boundedToolResult(content, toolCallId, options.maxResultTokens, options.searchSnippetChars);
  if (preview === content) return content;
  const value = parse(preview);
  return JSON.stringify({ ...value, originalUrl: `/tool-result?session_id=${encodeURIComponent(sessionId)}&tool_call_id=${encodeURIComponent(toolCallId)}` });
}
