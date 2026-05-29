import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, HookContext } from "../types.js";
import type { ChatResponse, ContentBlock, Message, ToolUseBlock } from "../../types.js";
import { listMemories, saveMemory } from "../../tools/memory.js";

const DEFAULT_TURN_THRESHOLD = 10;
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MAX_BATCH_CHARS = 8000;

const AUTO_MEMORY_PROMPT = `你是 tiny-claw 的长期记忆整理器。请从一段增量对话中判断是否有值得长期记住的信息。

只保留对未来对话持续有用、稳定、可复用的信息，例如：
- 用户长期偏好、身份信息、工作方式、输出风格要求。
- 当前项目的稳定约定、技术栈、架构决策、重要路径。
- 用户明确要求以后遵守的规则。

不要保存：
- 一次性任务过程、临时 debug 信息、普通问答内容、工具日志、代码 diff 细节。
- API key、token、cookie、密码、AppSecret 等凭证。此类内容必须标记 sensitive=true，decision=pending 或 ignore。
- 不确定、含糊、只在当前任务有效的信息。

请只输出 JSON，不要输出解释。格式：
{
  "memories": [
    {
      "decision": "save" | "pending" | "ignore",
      "name": "kebab-case-or-snake_case",
      "summary": "不超过80字的中文摘要",
      "content": "Markdown 格式的记忆正文",
      "tags": ["preference", "project"],
      "scope": "global" | "project" | "user",
      "sensitive": false,
      "confidence": 0.0,
      "reason": "简短原因"
    }
  ]
}

decision 规则：
- save：高置信、非敏感、长期稳定，适合直接写入长期记忆。
- pending：有价值但需要用户确认，或包含敏感/不确定信息。
- ignore：不应保存。

最多返回指定数量的候选；没有候选时返回 {"memories": []}。`;

interface PendingTurn {
  user: string;
  assistant: string;
  at: string;
}

interface SessionMemoryState {
  turnsSinceAnalysis: number;
  pendingTurns: PendingTurn[];
  analyzing: boolean;
}

interface MemoryCandidate {
  decision?: string;
  name?: string;
  summary?: string;
  content?: string;
  tags?: unknown;
  scope?: string;
  sensitive?: boolean;
  confidence?: number;
  reason?: string;
}

function isEnabled(ctx: HookContext): boolean {
  return ctx.config.autoMemory?.enabled !== false;
}

function isSubAgentSession(sessionId: string): boolean {
  return sessionId.startsWith("sub:");
}

function getTurnThreshold(ctx: HookContext): number {
  const value = ctx.config.autoMemory?.turnThreshold;
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_TURN_THRESHOLD;
  return Math.min(Math.floor(value), 100);
}

function getMinConfidence(ctx: HookContext): number {
  const value = ctx.config.autoMemory?.minConfidence;
  if (!Number.isFinite(value)) return DEFAULT_MIN_CONFIDENCE;
  return Math.max(0, Math.min(value ?? DEFAULT_MIN_CONFIDENCE, 1));
}

function getMaxCandidates(ctx: HookContext): number {
  const value = ctx.config.autoMemory?.maxCandidates;
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_MAX_CANDIDATES;
  return Math.min(Math.floor(value), 20);
}

function getMaxBatchChars(ctx: HookContext): number {
  const value = ctx.config.autoMemory?.maxBatchChars;
  if (!Number.isFinite(value) || !value || value < 1000) return DEFAULT_MAX_BATCH_CHARS;
  return Math.min(Math.floor(value), 30000);
}

function getMode(ctx: HookContext): "auto" | "hybrid" | "suggest" {
  const mode = ctx.config.autoMemory?.mode;
  if (mode === "auto" || mode === "suggest" || mode === "hybrid") return mode;
  return "hybrid";
}

function blockToText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") return `[工具调用 ${block.name}]: ${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return `[工具结果]: ${block.content.slice(0, 1000)}`;
  return "";
}

function messageToText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(blockToText).filter(Boolean).join("\n");
}

function responseToText(response: ChatResponse): string {
  const parts: string[] = [];
  if (response.text.trim()) parts.push(response.text.trim());
  for (const toolCall of response.toolCalls) {
    parts.push(`[工具调用 ${toolCall.name}]: ${JSON.stringify(toolCall.input)}`);
  }
  return parts.join("\n");
}

function assistantMessageFromResponse(response: ChatResponse): Message {
  const content: Array<ToolUseBlock | { type: "text"; text: string }> = [];
  if (response.text.trim()) content.push({ type: "text", text: response.text });
  content.push(...response.toolCalls);
  return { role: "assistant", content };
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[已截断]` : text;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty model response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object found");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function normalizeName(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || fallback;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 10);
}

function pendingDir(workspacePath: string): string {
  const dir = resolve(workspacePath, "memory", "pending");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePendingMemory(workspacePath: string, candidate: MemoryCandidate, sessionId: string): void {
  const timestamp = new Date().toISOString();
  const baseName = normalizeName(candidate.name, `memory-${Date.now()}`);
  const fileName = `${Date.now()}-${baseName}.json`;
  const filePath = resolve(pendingDir(workspacePath), fileName);
  writeFileSync(
    filePath,
    JSON.stringify({ ...candidate, sessionId, createdAt: timestamp }, null, 2),
    "utf-8",
  );
}

function shouldSaveCandidate(ctx: HookContext, candidate: MemoryCandidate): boolean {
  if (getMode(ctx) === "suggest") return false;
  if (candidate.decision !== "save") return false;
  if (candidate.sensitive === true) return false;
  if ((candidate.confidence ?? 0) < getMinConfidence(ctx)) return false;
  return Boolean(candidate.name?.trim() && candidate.content?.trim());
}

function shouldKeepPending(ctx: HookContext, candidate: MemoryCandidate): boolean {
  if (!candidate.name?.trim() && !candidate.content?.trim() && !candidate.summary?.trim()) return false;
  if (candidate.decision === "ignore") return false;
  if (getMode(ctx) === "auto" && candidate.sensitive !== true) return false;
  return true;
}

function findCurrentUserInput(ctx: HookContext): string {
  const currentTurn = ctx.history.getCurrentTurnMessages();
  const originalUser = currentTurn.find((message) => message.role === "user" && typeof message.content === "string");
  if (originalUser) return messageToText(originalUser);

  const recent = ctx.history.getRecentMessages(1);
  const recentUser = [...recent].reverse().find((message) => message.role === "user" && typeof message.content === "string");
  return recentUser ? messageToText(recentUser) : "";
}

function parseCandidates(raw: string, maxCandidates: number): MemoryCandidate[] {
  const parsed = extractJsonObject(raw) as { memories?: unknown };
  if (!Array.isArray(parsed.memories)) return [];
  return parsed.memories
    .filter((item): item is MemoryCandidate => typeof item === "object" && item !== null)
    .slice(0, maxCandidates);
}

function formatTurns(turns: PendingTurn[]): string {
  return turns.map((turn, index) => [
    `### Turn ${index + 1} (${turn.at})`,
    `[user] ${turn.user}`,
    `[assistant] ${turn.assistant}`,
  ].join("\n")).join("\n\n");
}

export const coreAutoMemoryPlugin: Plugin = {
  name: "core-auto-memory",
  async init(ctx) {
    const states = new Map<string, SessionMemoryState>();

    ctx.registerHooks({
      onChatResponse: async (hookCtx: HookContext, response: ChatResponse) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return response;
        if (response.toolCalls.length > 0) return response;

        const state = states.get(hookCtx.sessionId) ?? {
          turnsSinceAnalysis: 0,
          pendingTurns: [],
          analyzing: false,
        };

        state.turnsSinceAnalysis += 1;
        state.pendingTurns.push({
          user: findCurrentUserInput(hookCtx),
          assistant: messageToText(assistantMessageFromResponse(response)) || responseToText(response),
          at: new Date().toISOString(),
        });

        states.set(hookCtx.sessionId, state);

        if (state.analyzing || state.turnsSinceAnalysis < getTurnThreshold(hookCtx)) {
          return response;
        }

        state.analyzing = true;
        const turnsToAnalyze = [...state.pendingTurns];
        state.pendingTurns = [];
        state.turnsSinceAnalysis = 0;
        states.set(hookCtx.sessionId, state);

        try {
          const existingMemories = listMemories(hookCtx.config.workspacePath, false);
          const prompt = `${AUTO_MEMORY_PROMPT}

最多候选数量：${getMaxCandidates(hookCtx)}
最低自动保存置信度：${getMinConfidence(hookCtx)}
当前模式：${getMode(hookCtx)}

已有非敏感长期记忆索引：
${existingMemories}

本次需要整理的增量对话：
${truncateText(formatTurns(turnsToAnalyze), getMaxBatchChars(hookCtx))}`;

          const raw = await hookCtx.client.complete(
            [{ role: "user", content: prompt }],
            "你是长期记忆整理器。只输出严格 JSON。",
          );
          const candidates = parseCandidates(raw, getMaxCandidates(hookCtx));

          let saved = 0;
          let pending = 0;
          for (const candidate of candidates) {
            if (shouldSaveCandidate(hookCtx, candidate)) {
              const name = normalizeName(candidate.name, `auto-memory-${Date.now()}-${saved + pending}`);
              saveMemory(hookCtx.config.workspacePath, name, candidate.content!, {
                tags: normalizeTags(candidate.tags),
                sensitive: false,
                scope: candidate.scope || "global",
                summary: candidate.summary,
              });
              saved += 1;
            } else if (shouldKeepPending(hookCtx, candidate)) {
              writePendingMemory(hookCtx.config.workspacePath, candidate, hookCtx.sessionId);
              pending += 1;
            }
          }

          if (saved > 0 || pending > 0) {
            ctx.log("INFO", `自动记忆整理完成: saved=${saved}, pending=${pending}`, hookCtx.sessionId);
          }
        } catch (err) {
          state.pendingTurns = [...turnsToAnalyze, ...state.pendingTurns].slice(-getTurnThreshold(hookCtx) * 2);
          state.turnsSinceAnalysis = Math.min(state.pendingTurns.length, getTurnThreshold(hookCtx) - 1);
          ctx.log(
            "WARN",
            `自动记忆整理失败: ${err instanceof Error ? err.message : String(err)}`,
            hookCtx.sessionId,
          );
        } finally {
          state.analyzing = false;
          states.set(hookCtx.sessionId, state);
        }

        return response;
      },
    });
  },
};
