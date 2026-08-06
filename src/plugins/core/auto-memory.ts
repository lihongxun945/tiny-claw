import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, HookContext } from "../types.js";
import type { ChatResponse, Config, Message, Tool, ToolDefinition, ToolResultBlock, ToolUseBlock, AgentActor } from "../../types.js";
import type { ModelClient } from "../../model/index.js";
import {
  createAutoMemoryTurnId,
  loadSessionState,
  updateSessionState,
  type PersistedSessionState,
} from "../../session-state.js";
import { listSessionMetas } from "../../session-store.js";
import { loadAllMemories } from "../../tools/memory.js";
import { appendLog } from "../../workspace/logger.js";

const DEFAULT_TURN_THRESHOLD = 10;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MAX_BATCH_CHARS = 8000;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 300;

const AUTO_MEMORY_PROMPT = `你是 tiny-claw 的长期记忆整理器。你的任务不是总结对话，而是维护长期有效的 memory 文件。

你必须通过可用的 memory 工具完成整理，不要输出自定义 JSON actions。

输入包含：
1. 当前已保存的长期记忆全文。
2. 最近若干轮增量对话。每轮只包含用户问题和最终回答，不包含工具调用过程、工具结果或调试日志。

你需要判断是否要新增、更新、压缩、删除或忽略长期记忆。

只处理对未来对话持续有用、稳定、可复用的信息：
- 用户明确要求“记住”“以后都按这个”。
- 用户长期偏好、称呼方式、输出风格、工作方式。
- 当前项目稳定约定、架构决策、技术栈、重要路径。
- 已确认的流程规范、长期规则、反复出现的需求。

不要保存：
- 一次性任务过程、临时 debug 信息、普通问答内容。
- 工具调用过程、工具结果、搜索片段、代码 diff 细节。
- 没被用户确认的推测。
- 只在当前会话或当前任务有效的信息。
- API key、token、cookie、密码、AppSecret 等凭证。

工具使用规则：
- 输入已经包含已保存记忆全文；只有需要核对最新磁盘状态时，才调用 memory_list 或 memory_read。
- 新主题使用 memory_save 创建记忆。
- 同主题已有记忆时，优先用 memory_save 覆盖同名记忆。content 必须是整理后的完整正文，包含仍然有效的旧信息和新信息，并移除冲突或过期内容。不要 append 式堆叠碎片。
- 已有记忆过长、重复、碎片化或包含过期内容时，即使没有新增事实，也可以调用 memory_save 用同名记忆写回压缩整理后的完整正文。
- 只有用户明确要求忘记/删除、明确表示某条规则已废弃、新规则明确替代旧规则且旧规则不应继续使用、或已有 memory 被确认错误时，才可以调用 memory_delete。
- 如果没有值得长期保存或更新的内容，不要调用写入工具，直接说明无需更新。

置信度规则：
- 用户明确表达且几乎无歧义，才写入或删除。
- 强相关但仍有不确定时，只在最终文本中提出建议，不要写入或删除。
- 不要因为“暂时没提到”就删除。

内容要求：
- memory_save 的 content 使用 Markdown，必须完整、可独立理解，不要只写摘要。
- 每条记忆正文不得超过系统给出的最大字符数；如果过长，必须整理、合并、去重和压缩到限制内。
- 最终文本用一句话概括本次整理结果。`;

export interface AutoMemoryTurn {
  id: string;
  user: string;
  assistant: string;
  at: string;
  sessionId?: string;
}

export interface AutoMemoryAnalysisResult {
  saved: number;
  updated: number;
  deleted: number;
  pending: number;
  toolCalls: number;
  analyzedTurns: number;
  finalText: string;
  requiresConfirmation: boolean;
  affectedSessions?: string[];
}

export type AutoMemoryTrigger = "threshold" | "dream";
export type AutoMemoryLogger = (
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  sessionId?: string,
) => void;

export function createAutoMemoryLogger(workspacePath: string, fallback?: AutoMemoryLogger): AutoMemoryLogger {
  return (level, message, sessionId) => {
    appendLog(workspacePath, level, message, sessionId);
    fallback?.(level, message, sessionId);
  };
}

type AutoMemoryMode = "auto" | "hybrid" | "suggest";

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

function getMaxCandidates(config: Config): number {
  const value = config.autoMemory?.maxCandidates;
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_MAX_CANDIDATES;
  return Math.min(Math.floor(value), 20);
}

function getMaxBatchChars(config: Config): number {
  const value = config.autoMemory?.maxBatchChars;
  if (!Number.isFinite(value) || !value || value < 1000) return DEFAULT_MAX_BATCH_CHARS;
  return Math.min(Math.floor(value), 30000);
}

function getMaxMemoryChars(config: Config): number {
  return config.memory?.maxItemChars ?? 20000;
}

function getLockTimeoutSeconds(config: Config): number {
  const value = config.autoMemory?.lockTimeoutSeconds;
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_LOCK_TIMEOUT_SECONDS;
  return Math.floor(value);
}

function getMode(config: Config): AutoMemoryMode {
  const mode = config.autoMemory?.mode;
  if (mode === "auto" || mode === "suggest" || mode === "hybrid") return mode;
  return "hybrid";
}

function messageToText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[已截断]` : text;
}

function findCurrentUserInput(ctx: HookContext): string {
  const currentTurn = ctx.history.getCurrentTurnMessages();
  const originalUser = currentTurn.find((message) => message.role === "user" && typeof message.content === "string");
  if (originalUser) return messageToText(originalUser);

  const recent = ctx.history.getRecentMessages(1);
  const recentUser = [...recent].reverse().find((message) => message.role === "user" && typeof message.content === "string");
  return recentUser ? messageToText(recentUser) : "";
}

function appendPendingTurn(state: PersistedSessionState, turn: AutoMemoryTurn, maxPendingTurns: number): PersistedSessionState {
  const pendingTurns = [...state.autoMemory.pendingTurns, turn].slice(-maxPendingTurns);
  return {
    ...state,
    autoMemory: {
      ...state.autoMemory,
      pendingTurns,
      turnsSinceAnalysis: pendingTurns.length,
    },
  };
}

function markAutoMemoryAnalyzed(
  state: PersistedSessionState,
  processedTurnIds: Set<string>,
  result: AutoMemoryAnalysisResult,
): PersistedSessionState {
  const now = new Date().toISOString();
  const pendingTurns = state.autoMemory.pendingTurns.filter((turn) => !processedTurnIds.has(turn.id));
  return {
    ...state,
    autoMemory: {
      pendingTurns,
      turnsSinceAnalysis: pendingTurns.length,
      lastAnalyzedAt: now,
      lastAnalyzedTurnAt: state.autoMemory.pendingTurns
        .filter((turn) => processedTurnIds.has(turn.id))
        .at(-1)?.at,
      lastResult: {
        analyzedTurns: result.analyzedTurns,
        toolCalls: result.toolCalls,
        saved: result.saved,
        deleted: result.deleted,
        at: now,
      },
    },
  };
}

function collectWorkspaceAutoMemoryTurns(workspacePath: string, includeSessionIds: string[] = []): {
  turns: AutoMemoryTurn[];
  snapshots: Array<{ sessionId: string; turnIds: string[] }>;
} {
  const sessionIds = new Set<string>(includeSessionIds);
  for (const meta of listSessionMetas(workspacePath)) {
    if (!isSubAgentSession(meta.id)) sessionIds.add(meta.id);
  }

  const snapshots: Array<{ sessionId: string; turnIds: string[] }> = [];
  const turns: AutoMemoryTurn[] = [];
  for (const sessionId of sessionIds) {
    if (isSubAgentSession(sessionId)) continue;
    const state = loadSessionState(workspacePath, sessionId);
    if (state.autoMemory.pendingTurns.length === 0) continue;
    snapshots.push({
      sessionId,
      turnIds: state.autoMemory.pendingTurns.map((turn) => turn.id),
    });
    for (const turn of state.autoMemory.pendingTurns) {
      turns.push({ ...turn, sessionId });
    }
  }

  turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { turns, snapshots };
}

function countWorkspacePendingTurns(workspacePath: string, includeSessionIds: string[] = []): number {
  return collectWorkspaceAutoMemoryTurns(workspacePath, includeSessionIds).turns.length;
}

function markWorkspaceAutoMemoryAnalyzed(
  workspacePath: string,
  snapshots: Array<{ sessionId: string; turnIds: string[] }>,
  result: AutoMemoryAnalysisResult,
): void {
  for (const snapshot of snapshots) {
    const processedTurnIds = new Set(snapshot.turnIds);
    updateSessionState(workspacePath, snapshot.sessionId, (latest) => {
      const next = markAutoMemoryAnalyzed(latest, processedTurnIds, result);
      return {
        sessionId: next.sessionId,
        summary: next.summary,
        pendingMessages: next.pendingMessages,
        turnsSinceSummary: next.turnsSinceSummary,
        autoMemory: next.autoMemory,
      };
    });
  }
}

function formatTurns(turns: AutoMemoryTurn[]): string {
  if (turns.length === 0) {
    return "本次没有新增对话，请只检查已有长期记忆是否需要压缩、合并、删除或保持不变。";
  }

  const groups = new Map<string, AutoMemoryTurn[]>();
  for (const turn of turns) {
    const sessionId = turn.sessionId ?? "unknown";
    groups.set(sessionId, [...(groups.get(sessionId) ?? []), turn]);
  }

  return [...groups.entries()].map(([sessionId, sessionTurns]) => [
    `### Session ${sessionId}`,
    ...sessionTurns.map((turn, index) => [
      `#### Turn ${index + 1} (${turn.at})`,
      `[user] ${turn.user}`,
      `[assistant] ${turn.assistant}`,
    ].join("\n")),
  ].join("\n")).join("\n\n");
}

function allowedToolNames(mode: AutoMemoryMode): Set<string> {
  if (mode === "auto") {
    return new Set(["memory_list", "memory_read", "memory_save", "memory_delete"]);
  }
  if (mode === "hybrid") {
    return new Set(["memory_list", "memory_read", "memory_save"]);
  }
  return new Set(["memory_list", "memory_read"]);
}

function filterToolDefinitions(definitions: ToolDefinition[], mode: AutoMemoryMode): ToolDefinition[] {
  const allowed = allowedToolNames(mode);
  return definitions.filter((definition) => allowed.has(definition.name));
}

function buildUserPrompt(workspacePath: string, config: Config, turns: AutoMemoryTurn[]): string {
  const mode = getMode(config);
  const modeRule = mode === "auto"
    ? "auto：可以自动保存、更新和删除高确定性的长期记忆。"
    : mode === "hybrid"
      ? "hybrid：可以自动保存和更新；如果发现需要删除的记忆，只能在最终文本中提出建议，不要删除。"
      : "suggest：只能读取记忆并在最终文本中提出建议，不要保存、更新或删除。";

  const maxBatchChars = getMaxBatchChars(config);
  const memories = loadAllMemories(workspacePath).trim() || "暂无已保存长期记忆。";

  return [
    `当前模式：${modeRule}`,
    `最多 memory 工具调用次数：${getMaxCandidates(config)}`,
    `单条记忆正文最大字符数：${getMaxMemoryChars(config)}`,
    `所有启用记忆正文总字符上限：${config.memory?.maxTotalChars ?? 80000}`,
    `增量对话输入字符预算：最多 ${maxBatchChars} 字`,
    "",
    "当前已保存的长期记忆全文：",
    memories,
    "",
    "本次需要整理的增量对话：",
    truncateText(formatTurns(turns), maxBatchChars),
  ].join("\n");
}

function responseToAssistantMessage(response: ChatResponse): Message {
  const content = [
    ...(response.text ? [{ type: "text" as const, text: response.text }] : []),
    ...response.toolCalls,
  ];
  return {
    role: "assistant",
    content: content.length > 0 ? content : "",
  };
}

function toolResultsToUserMessage(results: ToolResultBlock[]): Message {
  return {
    role: "user",
    content: results,
  };
}

function normalizeToolInput(toolCall: ToolUseBlock, config: Config): Record<string, unknown> {
  if (toolCall.name !== "memory_save") return toolCall.input;
  const input = { ...toolCall.input };
  input.source = "auto";
  return input;
}

function isConfirmationResult(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { requiresConfirmation?: boolean };
    return parsed.requiresConfirmation === true;
  } catch {
    return false;
  }
}

function isToolErrorResult(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length > 0;
  } catch {
    return false;
  }
}

async function executeMemoryTool(options: {
  toolCall: ToolUseBlock;
  tool: Tool;
  config: Config;
  sessionId: string;
  actor?: AgentActor;
}): Promise<string> {
  const input = normalizeToolInput(options.toolCall, options.config);
  return options.tool.execute(input, {
    sessionId: options.sessionId,
    actor: options.actor,
  });
}

export async function runAutoMemoryAnalysis(options: {
  workspacePath: string;
  config: Config;
  client: ModelClient;
  sessionId: string;
  turns: AutoMemoryTurn[];
  getToolDefinitions: () => ToolDefinition[];
  getTool: (name: string) => Tool | undefined;
  actor?: AgentActor;
  onToolCall?: (toolCall: ToolUseBlock, input: Record<string, unknown>) => void;
}): Promise<AutoMemoryAnalysisResult> {
  const turnsToAnalyze = options.turns.filter((turn) => turn.user.trim() && turn.assistant.trim());
  const empty = {
    saved: 0,
    updated: 0,
    deleted: 0,
    pending: 0,
    toolCalls: 0,
    analyzedTurns: 0,
    finalText: "",
    requiresConfirmation: false,
  };

  const mode = getMode(options.config);
  const allowedTools = allowedToolNames(mode);
  const tools = filterToolDefinitions(options.getToolDefinitions(), mode);
  if (tools.length === 0) {
    return {
      ...empty,
      analyzedTurns: turnsToAnalyze.length,
      finalText: "没有可用的 memory 工具，已跳过记忆整理。",
    };
  }

  const messages: Message[] = [{ role: "user", content: buildUserPrompt(options.workspacePath, options.config, turnsToAnalyze) }];
  const maxToolCalls = getMaxCandidates(options.config);
  let toolCalls = 0;
  let saved = 0;
  let deleted = 0;
  let finalText = "";

  while (toolCalls < maxToolCalls) {
    const response = await options.client.chat(messages, () => {}, tools, AUTO_MEMORY_PROMPT);
    finalText = response.text.trim();
    if (response.toolCalls.length === 0) break;

    messages.push(responseToAssistantMessage(response));
    const results: ToolResultBlock[] = [];
    for (const toolCall of response.toolCalls) {
      if (toolCalls >= maxToolCalls) break;
      toolCalls += 1;

      const tool = allowedTools.has(toolCall.name) ? options.getTool(toolCall.name) : undefined;
      let result: string;
      let executed = false;
      if (!tool) {
        result = `工具不可用或不允许自动记忆调用：${toolCall.name}`;
      } else {
        options.onToolCall?.(toolCall, normalizeToolInput(toolCall, options.config));
        result = await executeMemoryTool({
          toolCall,
          tool,
          config: options.config,
          sessionId: options.sessionId,
          actor: options.actor,
        });
        executed = true;
      }

      results.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result,
      });

      if (isConfirmationResult(result)) {
        return {
          saved,
          updated: 0,
          deleted,
          pending: 0,
          toolCalls,
          analyzedTurns: turnsToAnalyze.length,
          finalText: "记忆整理触发了权限审批，等待用户批准后才能继续。",
          requiresConfirmation: true,
        };
      }
      if (executed && !isToolErrorResult(result) && toolCall.name === "memory_save") saved += 1;
      if (executed && !isToolErrorResult(result) && toolCall.name === "memory_delete") deleted += 1;
    }

    messages.push(toolResultsToUserMessage(results));
  }

  return {
    saved,
    updated: 0,
    deleted,
    pending: 0,
    toolCalls,
    analyzedTurns: turnsToAnalyze.length,
    finalText,
    requiresConfirmation: false,
  };
}

export async function runWorkspaceAutoMemoryAnalysis(options: {
  workspacePath: string;
  config: Config;
  client: ModelClient;
  triggerSessionId: string;
  getToolDefinitions: () => ToolDefinition[];
  getTool: (name: string) => Tool | undefined;
  actor?: AgentActor;
  trigger?: AutoMemoryTrigger;
  log?: AutoMemoryLogger;
}): Promise<AutoMemoryAnalysisResult> {
  const trigger = options.trigger ?? "threshold";
  const startedAt = Date.now();
  const lock = acquireAutoMemoryLock(options.workspacePath, getLockTimeoutSeconds(options.config));
  if (!lock) {
    const pending = countWorkspacePendingTurns(options.workspacePath, [options.triggerSessionId]);
    options.log?.(
      "INFO",
      `[AUTO_MEMORY] 跳过整理 trigger=${trigger} reason=workspace_lock_held pendingTurns=${pending}`,
      options.triggerSessionId,
    );
    return {
      saved: 0,
      updated: 0,
      deleted: 0,
      pending,
      toolCalls: 0,
      analyzedTurns: 0,
      finalText: "已有记忆整理任务正在运行，本次已跳过。",
      requiresConfirmation: false,
      affectedSessions: [],
    };
  }

  try {
    const { turns, snapshots } = collectWorkspaceAutoMemoryTurns(options.workspacePath, [options.triggerSessionId]);
    options.log?.(
      "INFO",
      `[AUTO_MEMORY] 开始整理 trigger=${trigger} sessions=${snapshots.length} turns=${turns.length} maxMemoryChars=${getMaxMemoryChars(options.config)} maxTotalChars=${options.config.memory?.maxTotalChars ?? 80000}`,
      options.triggerSessionId,
    );
    const result = await runAutoMemoryAnalysis({
      workspacePath: options.workspacePath,
      config: options.config,
      client: options.client,
      sessionId: options.triggerSessionId,
      turns,
      getToolDefinitions: options.getToolDefinitions,
      getTool: options.getTool,
      actor: options.actor,
      onToolCall: (toolCall, input) => {
        const name = typeof input.name === "string" ? input.name : "-";
        options.log?.(
          "INFO",
          `[AUTO_MEMORY] 调用工具 trigger=${trigger} tool=${toolCall.name} name=${name}`,
          options.triggerSessionId,
        );
      },
    });

    if (!result.requiresConfirmation) {
      markWorkspaceAutoMemoryAnalyzed(options.workspacePath, snapshots, result);
    }

    const finalResult = {
      ...result,
      pending: countWorkspacePendingTurns(options.workspacePath, [options.triggerSessionId]),
      affectedSessions: snapshots.map((snapshot) => snapshot.sessionId),
    };
    options.log?.(
      "INFO",
      `[AUTO_MEMORY] 整理完成 trigger=${trigger} durationMs=${Date.now() - startedAt} analyzedTurns=${finalResult.analyzedTurns} sessions=${finalResult.affectedSessions.length} toolCalls=${finalResult.toolCalls} saved=${finalResult.saved} deleted=${finalResult.deleted} pending=${finalResult.pending} requiresConfirmation=${finalResult.requiresConfirmation}`,
      options.triggerSessionId,
    );
    return finalResult;
  } catch (error) {
    const pending = countWorkspacePendingTurns(options.workspacePath, [options.triggerSessionId]);
    options.log?.(
      "WARN",
      `[AUTO_MEMORY] 整理失败 trigger=${trigger} durationMs=${Date.now() - startedAt} pendingTurnsRetained=${pending} error=${error instanceof Error ? error.message : String(error)}`,
      options.triggerSessionId,
    );
    throw error;
  } finally {
    lock.release();
  }
}

function acquireAutoMemoryLock(
  workspacePath: string,
  timeoutSeconds: number,
): { release: () => void } | null {
  const locksDir = resolve(workspacePath, ".locks");
  const lockPath = resolve(locksDir, "auto-memory.lock");
  mkdirSync(locksDir, { recursive: true });

  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const ownerAlive = isLockOwnerAlive(lockPath);
    if (ownerAlive !== false && !isLockExpired(lockPath, timeoutSeconds)) return null;
    rmSync(lockPath, { recursive: true, force: true });
    try {
      mkdirSync(lockPath);
    } catch (retryError) {
      if (isAlreadyExistsError(retryError)) return null;
      throw retryError;
    }
  }

  const runId = randomUUID();
  const ownerPath = resolve(lockPath, "owner.json");
  writeFileSync(ownerPath, `${JSON.stringify({
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf-8");
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // A removed lock no longer needs a heartbeat.
    }
  }, timeoutSeconds * 1000 / 3);
  heartbeat.unref();

  return {
    release: () => {
      clearInterval(heartbeat);
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf-8")) as { runId?: string };
        if (owner.runId === runId) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      } catch {
        // The lock was already reclaimed or removed.
      }
    },
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isLockOwnerAlive(lockPath: string): boolean | undefined {
  try {
    const owner = JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf-8")) as { pid?: unknown };
    if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0) return undefined;
    try {
      process.kill(Number(owner.pid), 0);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ESRCH") return false;
        if (error.code === "EPERM") return true;
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function isLockExpired(lockPath: string, timeoutSeconds: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > timeoutSeconds * 1000;
  } catch {
    return false;
  }
}

export const coreAutoMemoryPlugin: Plugin = {
  name: "core-auto-memory",
  async init(ctx) {
    let analyzing = false;
    const log = createAutoMemoryLogger(ctx.workspacePath, ctx.log);

    ctx.registerHooks({
      onChatResponse: async (hookCtx: HookContext, response: ChatResponse) => {
        if (!isEnabled(hookCtx) || isSubAgentSession(hookCtx.sessionId)) return response;
        if (response.toolCalls.length > 0) return response;
        const assistant = response.text.trim();
        if (!assistant) return response;

        updateSessionState(hookCtx.config.workspacePath, hookCtx.sessionId, (latest) => {
          const sessionState = appendPendingTurn(latest, {
            id: createAutoMemoryTurnId(),
            user: findCurrentUserInput(hookCtx),
            assistant,
            at: new Date().toISOString(),
          }, getTurnThreshold(hookCtx) * 2);
          return {
            sessionId: sessionState.sessionId,
            summary: sessionState.summary,
            pendingMessages: sessionState.pendingMessages,
            turnsSinceSummary: sessionState.turnsSinceSummary,
            autoMemory: sessionState.autoMemory,
          };
        });

        const workspacePendingTurns = countWorkspacePendingTurns(hookCtx.config.workspacePath, [hookCtx.sessionId]);
        const threshold = getTurnThreshold(hookCtx);
        if (analyzing) {
          log(
            "INFO",
            `[AUTO_MEMORY] 跳过整理 trigger=threshold reason=already_running pendingTurns=${workspacePendingTurns}`,
            hookCtx.sessionId,
          );
          return response;
        }
        if (workspacePendingTurns < threshold) {
          log(
            "INFO",
            `[AUTO_MEMORY] 跳过整理 trigger=threshold reason=below_threshold pendingTurns=${workspacePendingTurns} threshold=${threshold}`,
            hookCtx.sessionId,
          );
          return response;
        }

        analyzing = true;
        log(
          "INFO",
          `[AUTO_MEMORY] 后台整理已排队 trigger=threshold pendingTurns=${workspacePendingTurns} threshold=${threshold}`,
          hookCtx.sessionId,
        );

        void runWorkspaceAutoMemoryAnalysis({
            workspacePath: hookCtx.config.workspacePath,
            config: hookCtx.config,
            client: hookCtx.client,
            triggerSessionId: hookCtx.sessionId,
            getToolDefinitions: hookCtx.getToolDefinitions,
            getTool: hookCtx.getTool,
            trigger: "threshold",
            log,
          })
          .catch(() => {
            // runWorkspaceAutoMemoryAnalysis records the failure and retains pending turns.
          })
          .finally(() => {
            analyzing = false;
          });

        return response;
      },
    });
  },
};
