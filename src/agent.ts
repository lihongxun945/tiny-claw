import { ensureConfigFile, loadConfig } from "./config.js";
import { createModelClient, type ModelClient } from "./model/index.js";
import { MessageHistory } from "./history.js";
import { PluginManager } from "./plugin-manager.js";
import { ensureWorkspace } from "./workspace/workspace.js";
import { appendHistory } from "./workspace/logger.js";
import { sanitizeToolMessageChains, validateToolMessageChains } from "./message-sanitizer.js";
import { readSessionMessages } from "./session-store.js";
import {
  attachApprovalContinuation,
  clearApproval,
  clearTurnApproval,
  listSessionApprovalContinuations,
  type PendingApprovalContinuation,
} from "./tools/approval.js";
import { applySessionConfig } from "./project.js";
import { readSessionMeta } from "./session-store.js";
import type { AgentActor, ChatResponse, Config, ContentBlock, Message, ToolUseBlock, ToolResultBlock, SessionContext, ExecutionMode } from "./types.js";
import { randomUUID } from "node:crypto";
import { calculateMessageTokenBudget, calculateHardMessageTokenBudget, getEffectiveMaxContextTokens } from "./context-budget.js";
import { estimateTokens } from "./estimate-tokens.js";
import type { AgentStatusUpdate } from "./plugins/types.js";
import { createPreparedModelRequest } from "./context-snapshot.js";
import { readRun, startRun, updateRun, type SessionRun } from "./run-store.js";
import type { TurnEndReason } from "./plugins/types.js";

// === 事件类型 ===

export type AgentEvent =
  | { type: "run_state"; run: SessionRun }
  | ({ type: "status" } & AgentStatusUpdate)
  | { type: "context_usage"; usage: import("./plugins/types.js").ContextTokenUsage; iteration: number; attempt: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: Record<string, unknown>; startedAt?: number }
  | { type: "tool_result"; toolCallId: string; name: string; result: string; completedAt?: number }
  | { type: "done"; text: string; reason: TurnEndReason }
  | { type: "error"; message: string };

// === 流式事件队列 ===

class EventQueue {
  private queue: AgentEvent[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  push(event: AgentEvent): void {
    this.queue.push(event);
    while (this.waiters.length > 0) {
      this.waiters.shift()!();
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!();
    }
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    while (this.queue.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    }
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    return { value: undefined as any, done: true };
  }
}

// === AgentSession ===

function loadPersistedSessionMessages(
  workspacePath: string,
  sessionId: string,
  pendingToolCallIds: Set<string>,
): { messages: Message[]; currentTurnStart?: number } {
  const messages = readSessionMessages(workspacePath, sessionId);
  if (pendingToolCallIds.size === 0) return { messages: sanitizeToolMessageChains(messages) };
  let pendingIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => block.type === "tool_use" && pendingToolCallIds.has(block.id))) {
      pendingIndex = index;
      break;
    }
  }
  if (pendingIndex < 0) return { messages: sanitizeToolMessageChains(messages) };
  const previous = sanitizeToolMessageChains(messages.slice(0, pendingIndex));
  return { messages: [...previous, messages[pendingIndex]], currentTurnStart: previous.length };
}

export class AgentSession {
  readonly id: string;
  private config: Config;
  private client: ModelClient;
  private history: MessageHistory;
  private pluginManager: PluginManager;
  private systemPrompt: string;
  private workspacePath: string;
  private sessionContext: SessionContext;
  private activeController?: AbortController;
  private pendingApprovals = new Map<string, PendingApprovalContinuation>();
  lastActivity: number;

  getMessages(): Message[] {
    return this.history.getRecentMessages(Infinity);
  }

  isBusy(): boolean {
    return this.activeController !== undefined;
  }

  hasPendingApproval(): boolean {
    return this.pendingApprovals.size > 0;
  }

  cancel(): boolean {
    if (!this.activeController) return false;
    this.activeController.abort();
    return true;
  }

  async cancelPendingApprovals(): Promise<boolean> {
    if (this.activeController || !this.pendingApprovals.size) return false;
    const controller = new AbortController();
    this.activeController = controller;
    try {
      for (const [id, pending] of this.pendingApprovals) {
        updateRun(this.workspacePath, this.id, pending.turnId, { state: "cancelled", reason: "用户取消待审批任务", approvalId: undefined });
        for (const call of [pending.toolCall, ...pending.skippedToolCalls]) {
          await this.appendToolResult(call.id, JSON.stringify({ status: "blocked", executed: false, error: "用户已取消任务" }), pending.turnId);
        }
        clearApproval(this.workspacePath, id);
        this.pendingApprovals.delete(id);
        await this.pluginManager.endTurn(this.id, pending.turnId);
      }
      return true;
    } finally {
      this.activeController = undefined;
    }
  }
  private async *runTurnEndHooks(
    reason: TurnEndReason,
    iteration: number,
    fullText: string,
  ): AsyncGenerator<AgentEvent, string> {
    const turn = this.pluginManager.getTurnId(this.id);
    const queue = new EventQueue();
    for (const notice of await this.pluginManager.callOnTurnNotices(reason, iteration, this.id)) {
      if (this.history.getRecentMessages(Infinity).some((message) => message._messageId === notice.id)) continue;
      const text = `\n\n${notice.text}`;
      const persisted = await appendHistory(this.workspacePath, { role: "assistant", content: [{ type: "text", text }], _timestamp: Date.now(), _turnId: turn, _messageId: notice.id }, this.id);
      this.history.push(persisted);
      fullText += text;
      yield { type: "text_delta", text };
    }
    const promise = this.pluginManager.callOnTurnEnd(
      reason,
      iteration,
      this.id,
      (status) => {
        if (turn) {
          const run = updateRun(this.workspacePath, this.id, turn, { status });
          if (run) queue.push({ type: "run_state", run });
        }
        queue.push({ type: "status", ...status });
      },
      this.activeController?.signal,
    ).finally(() => queue.close());
    let event = await queue.next();
    while (!event.done) {
      yield event.value;
      event = await queue.next();
    }
    await promise;
    if (turn) {
      const run = updateRun(this.workspacePath, this.id, turn, {
        state: reason === "approval_required" ? "waiting_approval" : reason === "iteration_limit" ? "interrupted" : reason,
        status: undefined,
        ...(reason === "iteration_limit" ? { reason: "达到迭代上限" } : {}),
      });
      if (run) yield { type: "run_state", run };
    }
    return fullText;
  }


  private async notifyError(error: Error, iteration: number): Promise<void> {
    try {
      await this.pluginManager.callOnError(error, iteration, this.id);
    } catch {
      // Error hooks must never hide the original failure.
    }
  }

  constructor(
    id: string,
    workspacePath: string,
    pluginManager: PluginManager,
    configOverrides: Partial<Config> = {},
    client?: ModelClient,
    sessionContext?: SessionContext,
  ) {
    this.id = id;
    this.workspacePath = workspacePath;
    this.sessionContext = sessionContext ?? readSessionMeta(workspacePath, id)?.context ?? { mode: "chat" };
    ensureWorkspace(workspacePath);
    ensureConfigFile(workspacePath);

    const config = applySessionConfig({ ...loadConfig(workspacePath), ...configOverrides }, this.sessionContext);

    this.config = config;
    this.pluginManager = pluginManager;
    this.client = client ?? createModelClient(this.config, {
      sessionId: id,
      reportDebug: (event) => this.pluginManager.callOnModelDebug(event),
    });
    const persistedApprovals = listSessionApprovalContinuations(workspacePath, id);
    this.pendingApprovals = new Map(persistedApprovals
      .map(({ approval, continuation }) => [approval.id, continuation]));
    const restoredHistory = loadPersistedSessionMessages(
      workspacePath,
      id,
      new Set(persistedApprovals.map(({ continuation }) => continuation.toolCall.id)),
    );
    this.history = new MessageHistory(restoredHistory.messages, restoredHistory.currentTurnStart);
    this.lastActivity = Date.now();

    this.pluginManager.setRuntimeDeps(this.config, this.client, this.history, this.id, this.sessionContext);

    this.systemPrompt = "";
  }

  /** 执行一轮对话，返回事件流 */
  async *chat(
    userInput: string,
    actor?: AgentActor,
    userContent?: ContentBlock[],
    executionMode: ExecutionMode = "normal",
    turnId: string = randomUUID(),
    selectedPlanId?: string,
  ): AsyncGenerator<AgentEvent> {
    if (this.config.remoteModel?.enabled !== false && !this.config.apiKey.trim()) {
      yield { type: "error", message: "尚未配置模型 API Key，请先在配置页面填写并保存。" };
      return;
    }
    if (this.pendingApprovals.size > 0) {
      yield { type: "error", message: "当前会话有待审批的工具调用。请先批准或拒绝最新审批，再继续发送新任务。" };
      return;
    }
    if (this.activeController) {
      yield { type: "error", message: "会话正在执行中，请等待完成或先取消当前任务" };
      return;
    }
    const controller = new AbortController();
    this.activeController = controller;
    let started = false;
    try {
      const run = startRun(this.workspacePath, this.id, turnId, executionMode, undefined, selectedPlanId);
      started = true;
      await this.pluginManager.beginTurn(this.id, turnId, executionMode);
      yield { type: "run_state", run };
      yield this.activity("execution:preparing", "正在准备上下文...");
      this.lastActivity = Date.now();

      // 1. Before Chat Hook：日志记录 + 可能的阻断或输入修改
      const preparationEvents = new EventQueue();
      const preparation = this.pluginManager.callOnBeforeChat(
        userInput, this.id, controller.signal,
        (status) => preparationEvents.push({ type: "status", ...status }),
      ).finally(() => preparationEvents.close());
      let preparationEvent = await preparationEvents.next();
      while (!preparationEvent.done) {
        yield preparationEvent.value;
        preparationEvent = await preparationEvents.next();
      }
      const beforeResult = await preparation;
      if (beforeResult.abort) {
        updateRun(this.workspacePath, this.id, turnId, { state: "interrupted", reason: beforeResult.abort });
        yield { type: "error", message: beforeResult.abort };
        return;
      }

      // 2. 懒构建系统提示词
      if (!this.systemPrompt) {
        this.systemPrompt = await this.pluginManager.callOnBuildPrompt("", this.id);
      }

      // 3. User Message Hook：由插件决定如何写入当前会话历史
      const input = beforeResult.input;
      await this.pluginManager.callOnUserMessage(input, this.id, userContent);

      yield* this.runModelLoop(controller, actor, 0, "");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (started) {
        const run = updateRun(this.workspacePath, this.id, turnId, { state: controller.signal.aborted ? "cancelled" : "interrupted", reason: error.message });
        if (run) yield { type: "run_state", run };
      }
      await this.notifyError(error, 0);
      yield { type: "error", message: error.message };
    } finally {
      if (started && readRun(this.workspacePath, this.id, turnId)?.state === "running") updateRun(this.workspacePath, this.id, turnId, { state: "interrupted", reason: "执行提前结束" });
      clearTurnApproval(this.workspacePath, this.id, actor);
      await this.pluginManager.endTurn(this.id, turnId, this.pendingApprovals.size > 0);
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  /** 审批通过后，从挂起的工具调用继续执行同一个 Agent Loop。 */
  async *resumeApproval(approvalId: string, actor?: AgentActor): AsyncGenerator<AgentEvent> {
    if (this.activeController) {
      yield { type: "error", message: "会话正在执行中，请等待完成或先取消当前任务" };
      return;
    }

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      yield { type: "error", message: "审批已通过，但原会话没有可恢复的待执行任务；可能是服务重启或会话已被清理。" };
      return;
    }
    this.pendingApprovals.delete(approvalId);

    const controller = new AbortController();
    this.activeController = controller;
    let agentIteration = pending.iteration;

    try {
      yield { type: "run_state", run: startRun(this.workspacePath, this.id, pending.turnId, pending.executionMode, approvalId) };
      await this.pluginManager.beginTurn(this.id, pending.turnId, pending.executionMode);
      this.lastActivity = Date.now();
      if (!this.systemPrompt) {
        this.systemPrompt = await this.pluginManager.callOnBuildPrompt("", this.id);
      }

      const result = yield* this.executeTimedToolCall(pending.toolCall, controller, actor, agentIteration);
      await this.appendToolResult(pending.toolCall.id, result);
      clearApproval(this.workspacePath, approvalId);

      for (const skipped of pending.skippedToolCalls) {
        const skippedResult = JSON.stringify({
          error: "前一个工具调用需要授权，本工具调用已暂停执行。如仍需要，请重新发起该工具调用。",
        });
        await this.appendToolResult(skipped.id, skippedResult);
      }

      yield* this.runModelLoop(controller, actor, agentIteration, "");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const run = updateRun(this.workspacePath, this.id, pending.turnId, { state: controller.signal.aborted ? "cancelled" : "interrupted", reason: error.message });
      if (run) yield { type: "run_state", run };
      await this.notifyError(error, agentIteration);
      yield { type: "error", message: error.message };
    } finally {
      clearTurnApproval(this.workspacePath, this.id, actor);
      if (readRun(this.workspacePath, this.id, pending.turnId)?.state === "running") {
        updateRun(this.workspacePath, this.id, pending.turnId, { state: "interrupted", reason: "执行提前结束" });
      }
      await this.pluginManager.endTurn(this.id, pending.turnId, this.pendingApprovals.size > 0);
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  /** 拒绝待审批工具，并把拒绝结果送回原 Agent Loop。 */
  async *rejectApproval(approvalId: string, actor?: AgentActor): AsyncGenerator<AgentEvent> {
    if (this.activeController) {
      yield { type: "error", message: "会话正在执行中，请等待完成或先取消当前任务" };
      return;
    }
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      yield { type: "error", message: "审批记录没有可恢复的待执行任务" };
      return;
    }
    this.pendingApprovals.delete(approvalId);
    const controller = new AbortController();
    this.activeController = controller;
    const result = JSON.stringify({ error: "用户拒绝执行该工具调用", rejected: true });

    try {
      yield { type: "run_state", run: startRun(this.workspacePath, this.id, pending.turnId, pending.executionMode, approvalId) };
      await this.pluginManager.beginTurn(this.id, pending.turnId, pending.executionMode);
      this.lastActivity = Date.now();
      yield { type: "tool_call", toolCallId: pending.toolCall.id, name: pending.toolCall.name, input: pending.toolCall.input };
      yield { type: "tool_result", toolCallId: pending.toolCall.id, name: pending.toolCall.name, result };
      await this.appendToolResult(pending.toolCall.id, result);
      clearApproval(this.workspacePath, approvalId);
      for (const skipped of pending.skippedToolCalls) {
        const skippedResult = JSON.stringify({ error: "前一个工具调用已被用户拒绝，本工具调用未执行。" });
        await this.appendToolResult(skipped.id, skippedResult);
      }
      yield* this.runModelLoop(controller, actor, pending.iteration, "");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const run = updateRun(this.workspacePath, this.id, pending.turnId, { state: controller.signal.aborted ? "cancelled" : "interrupted", reason: error.message });
      if (run) yield { type: "run_state", run };
      await this.notifyError(error, pending.iteration);
      yield { type: "error", message: error.message };
    } finally {
      clearTurnApproval(this.workspacePath, this.id, actor);
      if (readRun(this.workspacePath, this.id, pending.turnId)?.state === "running") {
        updateRun(this.workspacePath, this.id, pending.turnId, { state: "interrupted", reason: "执行提前结束" });
      }
      await this.pluginManager.endTurn(this.id, pending.turnId, this.pendingApprovals.size > 0);
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private activity(stage: string, message: string): AgentEvent {
    const status = { stage, state: "started" as const, message, startedAt: Date.now() };
    const turn = this.pluginManager.getTurnId(this.id);
    const run = turn ? updateRun(this.workspacePath, this.id, turn, { status }) : undefined;
    return run ? { type: "run_state", run } : { type: "status", ...status };
  }

  private async *runModelLoop(
    controller: AbortController,
    actor: AgentActor | undefined,
    agentIteration: number,
    fullText: string,
  ): AsyncGenerator<AgentEvent> {
    const maxIterations = this.config.maxAgentIterations > 0 ? this.config.maxAgentIterations : Infinity;

    while (agentIteration < maxIterations) {
      if (controller.signal.aborted) throw new Error("会话已取消");
      agentIteration++;

      const turn = this.pluginManager.getTurnId(this.id);
      const run = turn ? readRun(this.workspacePath, this.id, turn) : undefined;
      if (run && run.state !== "running") {
        const reason = run.state === "waiting_user" ? "waiting_user" : "interrupted";
        fullText = yield* this.runTurnEndHooks(reason, agentIteration, fullText);
        yield { type: "done", text: fullText, reason };
        return;
      }

      const executionMode = this.pluginManager.getExecutionMode(this.id);
      yield this.activity("execution:preparing", "正在准备上下文...");
      const toolDefs = this.pluginManager.getToolDefinitions(this.sessionContext, executionMode, this.id, agentIteration);
      const turnPrompt = await this.pluginManager.callOnBuildTurnPrompt(this.systemPrompt, agentIteration, this.id);

      // 4. 获取上下文和完整请求预算
      const context = this.history.getRecentMessages(Infinity);
      const turnStartIdx = this.history.getTurnStartIndexInContext(Infinity);
      const messageTokenBudget = calculateMessageTokenBudget(this.config, turnPrompt, toolDefs);
      const hardMessageTokenBudget = calculateHardMessageTokenBudget(this.config, turnPrompt, toolDefs);

      // 5. Before Model Call Hook：上下文压缩等
      const hookEventQueue = new EventQueue();
      const hookPromise = this.pluginManager.callOnBeforeModelCall(
        {
          messages: context,
          turnStartIndex: turnStartIdx,
          messageTokenBudget,
          hardMessageTokenBudget,
          fixedInputTokens: getEffectiveMaxContextTokens(this.config) - this.config.maxTokens - hardMessageTokenBudget,
          reportStatus: (status) => {
            const turn = this.pluginManager.getTurnId(this.id);
            if (turn) {
              const run = updateRun(this.workspacePath, this.id, turn, { status: status.state === "started" ? { ...status, startedAt: status.startedAt ?? Date.now() } : undefined });
              if (run) hookEventQueue.push({ type: "run_state", run });
            }
            hookEventQueue.push({ type: "status", ...status });
          },
        },
        agentIteration,
        this.id,
        controller.signal,
      ).finally(() => hookEventQueue.close());
      let hookEvent = await hookEventQueue.next();
      while (!hookEvent.done) {
        yield hookEvent.value;
        hookEvent = await hookEventQueue.next();
      }
      const modifiedContext = await hookPromise;
      if (modifiedContext.messages !== context || modifiedContext.turnStartIndex !== turnStartIdx) {
        this.history.replaceWithCompressed(modifiedContext.messages, modifiedContext.turnStartIndex);
      }
      const effectiveTurnPrompt = modifiedContext.systemPromptSuffix
        ? `${turnPrompt}\n\n${modifiedContext.systemPromptSuffix}`
        : turnPrompt;
      const effectiveMessageTokenBudget = Math.min(
        modifiedContext.hardMessageTokenBudget ?? hardMessageTokenBudget,
        calculateHardMessageTokenBudget(this.config, effectiveTurnPrompt, toolDefs),
      );

      const modelMessages = modifiedContext.derivedContext
        ? [
            ...modifiedContext.messages.slice(0, modifiedContext.turnStartIndex),
            { role: "assistant" as const, content: modifiedContext.derivedContext },
            ...modifiedContext.messages.slice(modifiedContext.turnStartIndex),
          ]
        : modifiedContext.messages;
      const estimatedMessageTokens = estimateTokens(modelMessages);
      if (estimatedMessageTokens > effectiveMessageTokenBudget) {
        const error = new Error(
          `当前请求压缩后仍超过模型上下文限制（消息约 ${estimatedMessageTokens} tokens，预算 ${effectiveMessageTokenBudget} tokens）。请缩小单次输入或工具读取范围。`,
        );
        throw error;
      }
      const toolChainError = validateToolMessageChains(modelMessages);
      if (toolChainError) {
        const error = new Error(`上下文压缩产生了无效的工具消息链：${toolChainError}`);
        throw error;
      }

      // 6. 流式调用模型。成功但没有文本和工具调用时按配置重试。
      const emptyResponseRetries = this.config.emptyResponseRetries ?? 1;
      let response: ChatResponse | null = null;
      for (let attempt = 0; attempt <= emptyResponseRetries; attempt++) {
        const eventQueue = new EventQueue();
        let chatError: string | null = null;
        const retryPrompt = attempt === 0
          ? effectiveTurnPrompt
          : `${effectiveTurnPrompt}\n\n上一次模型响应为空。请继续完成当前任务，必须返回可见文本或有效工具调用。`;
        const preparedRequest = createPreparedModelRequest({
          contextSummaries: modifiedContext.contextSummaries,
          config: this.config,
          sessionId: this.id,
          turnId: this.pluginManager.getTurnId(this.id),
          iteration: agentIteration,
          attempt: attempt + 1,
          systemPrompt: retryPrompt,
          messages: modelMessages,
          tools: toolDefs,
        });
        await this.pluginManager.callOnModelRequestPrepared(preparedRequest, agentIteration, this.id);
        yield { type: "context_usage", usage: preparedRequest.usage, iteration: agentIteration, attempt: attempt + 1 };
        if (controller.signal.aborted) throw new Error("会话已取消");
        yield this.activity("execution:model_wait", "正在等待模型响应...");
        let receivedText = false;
        const chatPromise = this.client.chat(
          modelMessages.map(({
            _turnId: _ignoredTurnId,
            _messageId: _ignoredMessageId,
            _sequence: _ignoredSequence,
            ...message
          }) => message),
          (delta) => {
            if (!receivedText && delta) {
              receivedText = true;
              eventQueue.push(this.activity("execution:model_output", "正在生成回答..."));
            }
            fullText += delta;
            eventQueue.push({ type: "text_delta", text: delta });
          },
          toolDefs.length > 0 ? toolDefs : undefined,
          retryPrompt,
          controller.signal,
        ).then(
          (value) => {
            eventQueue.close();
            return value;
          },
          (err) => {
            chatError = err instanceof Error ? err.message : String(err);
            eventQueue.close();
            return null;
          },
        );

        let item = await eventQueue.next();
        while (!item.done) {
          yield item.value;
          item = await eventQueue.next();
        }
        response = await chatPromise;
        if (chatError || !response) {
          const error = new Error(controller.signal.aborted ? "会话已取消" : chatError || "未知错误");
          throw error;
        }
        if (response.text.trim() || response.toolCalls.length > 0) break;
        response = null;
      }

      if (!response) {
        const error = new Error(`模型连续 ${emptyResponseRetries + 1} 次返回空响应，任务已停止，请重试或更换模型。`);
        throw error;
      }

      // 7. Chat Response Hook：插件可修改回复文本（如追加统计信息）
      const modifiedResponse = await this.pluginManager.callOnChatResponse(response, agentIteration, this.id);
      if (modifiedResponse.text !== fullText) {
        // 插件修改了文本（通常是前缀），计算增量并推流
        const extra = modifiedResponse.text.endsWith(fullText)
          ? modifiedResponse.text.slice(0, -fullText.length)
          : "";
        if (extra) {
          fullText = modifiedResponse.text;
          yield { type: "text_delta", text: extra };
        }
      }

      // 8. 构造 assistant 消息
      const assistantContent: (ToolUseBlock | { type: "text"; text: string })[] = [];
      if (modifiedResponse.text) {
        assistantContent.push({ type: "text", text: modifiedResponse.text });
      }
      for (const tc of response.toolCalls) {
        assistantContent.push(tc);
      }

      if (assistantContent.length > 0) {
        const assistantMsg: Message = { role: "assistant", content: assistantContent,
          ...(response.reasoningContent !== undefined ? { _reasoningContent: response.reasoningContent } : {}),
          _timestamp: Date.now(), _turnId: this.pluginManager.getTurnId(this.id) };
        const persisted = await appendHistory(this.workspacePath, assistantMsg, this.id);
        this.history.push(persisted);
      }

      // 8. After Iteration Hook
      await this.pluginManager.callOnAfterIteration(agentIteration, this.id);

      // 9. 无工具调用，结束
      if (response.toolCalls.length === 0) {
        fullText = yield* this.runTurnEndHooks("completed", agentIteration, fullText);
        yield { type: "done", text: fullText, reason: "completed" };
        return;
      }

      // 10. 执行工具调用
      for (let toolCallIndex = 0; toolCallIndex < response.toolCalls.length; toolCallIndex++) {
        const toolCall = response.toolCalls[toolCallIndex];
        if (controller.signal.aborted) throw new Error("会话已取消");

        const result = yield* this.executeTimedToolCall(toolCall, controller, actor, agentIteration);

        if (requiresUserConfirmation(result)) {
          const approvalId = getApprovalId(result);
          if (approvalId) {
            const continuation = {
              toolCall,
              displayResult: result,
              skippedToolCalls: response.toolCalls.slice(toolCallIndex + 1),
              iteration: agentIteration,
              executionMode,
              turnId: this.pluginManager.getTurnId(this.id) ?? randomUUID(),
            };
            this.pendingApprovals.set(approvalId, continuation);
            attachApprovalContinuation(this.workspacePath, approvalId, continuation);
            updateRun(this.workspacePath, this.id, continuation.turnId, { approvalId });
          }
          fullText = yield* this.runTurnEndHooks("approval_required", agentIteration, fullText);
          yield { type: "done", text: fullText, reason: "approval_required" };
          return;
        }

        await this.appendToolResult(toolCall.id, result);
        const currentRun = turn ? readRun(this.workspacePath, this.id, turn) : undefined;
        if (currentRun && currentRun.state !== "running") {
          for (const skipped of response.toolCalls.slice(toolCallIndex + 1)) {
            const skippedResult = JSON.stringify({ status: "blocked", executed: false, code: "run_stopped", error: "运行已暂停或停止，本次调用未执行" });
            await this.appendToolResult(skipped.id, skippedResult);
            yield { type: "tool_call", toolCallId: skipped.id, name: skipped.name, input: skipped.input };
            yield { type: "tool_result", toolCallId: skipped.id, name: skipped.name, result: skippedResult };
          }
          const reason = currentRun.state === "waiting_user" ? "waiting_user" : "interrupted";
          fullText = yield* this.runTurnEndHooks(reason, agentIteration, fullText);
          yield { type: "done", text: fullText, reason };
          return;
        }
      }
    }

    if (this.config.maxAgentIterations > 0 && agentIteration >= maxIterations) {
      const notice = `\n\n任务已停止：Agent 已达到最大迭代次数（${this.config.maxAgentIterations} 次），当前任务可能尚未完成。你可以继续发送“继续”，或在设置中调整 maxAgentIterations。`;
      const noticeMessage: Message = {
        role: "assistant",
        content: [{ type: "text", text: notice.trim() }],
        _timestamp: Date.now(),
        _turnId: this.pluginManager.getTurnId(this.id),
      };
      const persisted = await appendHistory(this.workspacePath, noticeMessage, this.id);
      this.history.push(persisted);
      fullText = yield* this.runTurnEndHooks("iteration_limit", agentIteration, fullText);
      yield { type: "text_delta", text: notice };
      yield { type: "done", text: `${fullText}${notice}`, reason: "iteration_limit" };
    }
  }

  private async *executeTimedToolCall(toolCall: ToolUseBlock, controller: AbortController, actor: AgentActor | undefined, agentIteration: number): AsyncGenerator<AgentEvent, string> {
    const turn = this.pluginManager.getTurnId(this.id);
    const startedAt = Date.now();
    const saveTiming = (completedAt?: number) => {
      if (!turn) return;
      const run = readRun(this.workspacePath, this.id, turn);
      updateRun(this.workspacePath, this.id, turn, { toolTimings: { ...run?.toolTimings, [toolCall.id]: { startedAt, completedAt } } });
    };
    saveTiming();
    yield { type: "tool_call", toolCallId: toolCall.id, name: toolCall.name, input: toolCall.input, startedAt };
    let result: string;
    let completedAt: number;
    try {
      const queue = new EventQueue();
      queue.push(this.activity("execution:tool_check", `正在调用工具：${toolCall.name}`));
      const pending = this.executeToolCall(toolCall, controller, actor, agentIteration,
        (message) => queue.push(this.activity("execution:tool_running", message)),
      ).finally(() => queue.close());
      for (let event = await queue.next(); !event.done; event = await queue.next()) yield event.value;
      result = await pending;
    } finally {
      completedAt = Date.now();
      saveTiming(completedAt);
    }
    yield { type: "tool_result", toolCallId: toolCall.id, name: toolCall.name, result, completedAt };
    yield this.activity("execution:tool_finished", "工具已返回，正在处理结果...");
    return result;
  }

  private async executeToolCall(
    toolCall: ToolUseBlock,
    controller: AbortController,
    actor: AgentActor | undefined,
    agentIteration: number,
    reportActivity?: (message: string) => void,
  ): Promise<string> {
    // Before Tool Hook
    const beforeTool = await this.pluginManager.callOnBeforeTool(
      toolCall.name, toolCall.input, agentIteration, this.id,
    );
    const turn = this.pluginManager.getTurnId(this.id);
    if (beforeTool.abort) {
      if (beforeTool.stop && turn) updateRun(this.workspacePath, this.id, turn, { state: beforeTool.stopState ?? "interrupted", reason: beforeTool.abort });
      return JSON.stringify({ status: "blocked", executed: false, code: beforeTool.code, requiredAction: beforeTool.requiredAction, error: beforeTool.abort });
    }

    const tool = this.pluginManager.getTool(toolCall.name);
    const availableTools = this.pluginManager.getToolDefinitions(this.sessionContext, this.pluginManager.getExecutionMode(this.id), this.id, agentIteration);
    if (!availableTools.some((definition) => definition.name === toolCall.name)) {
      return JSON.stringify({ status: "blocked", reason: tool ? "currently_unavailable" : "unregistered_tool", retryable: !!tool,
        availableTools: availableTools.map((definition) => definition.name),
        error: tool ? `工具 ${toolCall.name} 在当前状态下尚未开放，本次调用未执行。这不代表整轮禁用；请先完成所需状态转换，再依据最新工具列表重试。` : `工具 ${toolCall.name} 未注册，本次调用未执行。请选择已注册且当前可用的工具。` });
    }
    let result: string;
    if (tool) {
      try {
        if (turn) updateRun(this.workspacePath, this.id, turn, { pendingToolCallId: toolCall.id });
        result = await tool.execute(toolCall.input, {
          reportActivity,
          signal: controller.signal,
          sessionId: this.id,
          actor,
          rootPath: this.sessionContext.project?.root ?? this.workspacePath,
          restrictToRoot: this.sessionContext.mode === "project",
          config: this.config,
          sessionContext: this.sessionContext,
          executionMode: this.pluginManager.getExecutionMode(this.id),
          turnId: this.pluginManager.getTurnId(this.id),
        });
      } catch (err) {
        await this.notifyError(err instanceof Error ? err : new Error(String(err)), agentIteration);
        result = JSON.stringify({
          error: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      result = JSON.stringify({ error: `未知工具: ${toolCall.name}` });
    }

    // After Tool Hook
    return this.pluginManager.callOnAfterTool(
      toolCall.name, result, agentIteration, this.id,
    );
  }

  private async appendToolResult(toolUseId: string, result: string, turnId = this.pluginManager.getTurnId(this.id)): Promise<void> {
    const toolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: result,
    };
    const toolResultMsg: Message = { role: "user", content: [toolResult], _timestamp: Date.now(), _turnId: turnId };
    const persisted = await appendHistory(this.workspacePath, toolResultMsg, this.id);
    this.history.push(persisted);
    if (turnId && readRun(this.workspacePath, this.id, turnId)?.pendingToolCallId === toolUseId) {
      updateRun(this.workspacePath, this.id, turnId, { pendingToolCallId: undefined });
    }
  }
}

function requiresUserConfirmation(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { requiresConfirmation?: unknown };
    return parsed.requiresConfirmation === true;
  } catch {
    return false;
  }
}

function getApprovalId(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { approvalId?: unknown };
    return typeof parsed.approvalId === "string" ? parsed.approvalId : undefined;
  } catch {
    return undefined;
  }
}
