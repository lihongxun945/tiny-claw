import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createModelClient, type ModelClient } from "./model/index.js";
import { MessageHistory } from "./history.js";
import { PluginManager } from "./plugin-manager.js";
import { ensureWorkspace } from "./workspace/workspace.js";
import { appendHistory } from "./workspace/logger.js";
import { sanitizeToolMessageChains } from "./message-sanitizer.js";
import type { AgentActor, Config, Message, ToolUseBlock, ToolResultBlock } from "./types.js";

// === 事件类型 ===

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "done"; text: string }
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

interface PendingApprovalContinuation {
  toolCall: ToolUseBlock;
  skippedToolCalls: ToolUseBlock[];
  iteration: number;
}

// === AgentSession ===

function loadPersistedSessionMessages(workspacePath: string, sessionId: string): Message[] {
  const historyDir = resolve(workspacePath, "history");
  if (!existsSync(historyDir)) return [];

  const messages: Message[] = [];
  const files = readdirSync(historyDir).filter((file) => file.endsWith(".jsonl")).sort();
  for (const file of files) {
    const lines = readFileSync(resolve(historyDir, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as Message & { _session?: string };
        if (record._session !== sessionId) continue;
        if (record.role !== "user" && record.role !== "assistant") continue;
        messages.push({
          role: record.role,
          content: record.content,
          _timestamp: record._timestamp,
        });
      } catch {
        // 忽略损坏的历史行，避免影响会话创建。
      }
    }
  }
  return sanitizeToolMessageChains(messages);
}

export class AgentSession {
  readonly id: string;
  private config: Config;
  private client: ModelClient;
  private history: MessageHistory;
  private pluginManager: PluginManager;
  private systemPrompt: string;
  private workspacePath: string;
  private activeController?: AbortController;
  private pendingApprovals = new Map<string, PendingApprovalContinuation>();
  lastActivity: number;

  getMessages(): Message[] {
    return this.history.getRecentMessages(Infinity);
  }

  isBusy(): boolean {
    return this.activeController !== undefined;
  }

  cancel(): boolean {
    if (!this.activeController) return false;
    this.activeController.abort();
    return true;
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
  ) {
    this.id = id;
    this.workspacePath = workspacePath;
    ensureWorkspace(workspacePath);

    this.config = { ...loadConfig(workspacePath), ...configOverrides };
    this.client = client ?? createModelClient(this.config);
    this.history = new MessageHistory(loadPersistedSessionMessages(workspacePath, id));
    this.lastActivity = Date.now();

    this.pluginManager = pluginManager;
    this.pluginManager.setRuntimeDeps(this.config, this.client, this.history, this.id);

    this.systemPrompt = "";
  }

  /** 执行一轮对话，返回事件流 */
  async *chat(userInput: string, actor?: AgentActor): AsyncGenerator<AgentEvent> {
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

    try {
      this.lastActivity = Date.now();

      // 1. Before Chat Hook：日志记录 + 可能的阻断或输入修改
      const beforeResult = await this.pluginManager.callOnBeforeChat(userInput, this.id);
      if (beforeResult.abort) {
        yield { type: "error", message: beforeResult.abort };
        return;
      }

      // 2. 懒构建系统提示词
      if (!this.systemPrompt) {
        this.systemPrompt = await this.pluginManager.callOnBuildPrompt("", this.id);
      }

      // 3. User Message Hook：由插件决定如何写入当前会话历史
      const input = beforeResult.input;
      await this.pluginManager.callOnUserMessage(input, this.id);

      yield* this.runModelLoop(controller, actor, 0, "");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.notifyError(error, 0);
      yield { type: "error", message: error.message };
    } finally {
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
      this.lastActivity = Date.now();
      if (!this.systemPrompt) {
        this.systemPrompt = await this.pluginManager.callOnBuildPrompt("", this.id);
      }

      const result = await this.executeToolCall(pending.toolCall, controller, actor, agentIteration);
      yield { type: "tool_call", name: pending.toolCall.name, input: pending.toolCall.input };
      yield { type: "tool_result", name: pending.toolCall.name, result };
      this.appendToolResult(pending.toolCall.id, result);

      for (const skipped of pending.skippedToolCalls) {
        const skippedResult = JSON.stringify({
          error: "前一个工具调用需要授权，本工具调用已暂停执行。如仍需要，请重新发起该工具调用。",
        });
        this.appendToolResult(skipped.id, skippedResult);
      }

      yield* this.runModelLoop(controller, actor, agentIteration, "");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.notifyError(error, agentIteration);
      yield { type: "error", message: error.message };
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
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

      // 4. 获取上下文
      const context = this.history.getRecentMessages(this.config.historyWindowSize);
      const turnStartIdx = this.history.getTurnStartIndexInContext(this.config.historyWindowSize);

      // 5. Before Model Call Hook：上下文压缩等
      const modifiedContext = await this.pluginManager.callOnBeforeModelCall(
        context, turnStartIdx, agentIteration, this.id,
      );
      if (modifiedContext !== context) {
        // 钩子修改了消息（如压缩），替换历史
        const estimatedTurnStart = modifiedContext.length - (context.length - turnStartIdx);
        this.history.replaceWithCompressed(modifiedContext, Math.max(0, estimatedTurnStart));
      }

      const toolDefs = this.pluginManager.getToolDefinitions();

      // 6. 流式调用模型
      const eventQueue = new EventQueue();
      let chatError: string | null = null;

      const chatPromise = this.client.chat(
        this.history.getRecentMessages(this.config.historyWindowSize),
        (delta) => {
          fullText += delta;
          eventQueue.push({ type: "text_delta", text: delta });
        },
        toolDefs.length > 0 ? toolDefs : undefined,
        this.systemPrompt,
        controller.signal,
      ).then(
        (response) => {
          eventQueue.close();
          return response;
        },
        (err) => {
          chatError = err instanceof Error ? err.message : String(err);
          eventQueue.close();
          return null;
        },
      );

      // 实时消费 text_delta
      let item = await eventQueue.next();
      while (!item.done) {
        yield item.value;
        item = await eventQueue.next();
      }

      // 等待 chat 完成
      const response = await chatPromise;

      if (chatError || !response) {
        const error = new Error(controller.signal.aborted ? "会话已取消" : chatError || "未知错误");
        await this.notifyError(error, agentIteration);
        yield { type: "error", message: error.message };
        return;
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
        const assistantMsg: Message = { role: "assistant", content: assistantContent, _timestamp: Date.now() };
        appendHistory(this.workspacePath, assistantMsg, this.id);
        this.history.push(assistantMsg);
      }

      // 8. After Iteration Hook
      await this.pluginManager.callOnAfterIteration(agentIteration, this.id);

      // 9. 无工具调用，结束
      if (response.toolCalls.length === 0) {
        yield { type: "done", text: fullText };
        return;
      }

      // 10. 执行工具调用
      for (let toolCallIndex = 0; toolCallIndex < response.toolCalls.length; toolCallIndex++) {
        const toolCall = response.toolCalls[toolCallIndex];
        if (controller.signal.aborted) throw new Error("会话已取消");

        yield { type: "tool_call", name: toolCall.name, input: toolCall.input };
        const result = await this.executeToolCall(toolCall, controller, actor, agentIteration);
        yield { type: "tool_result", name: toolCall.name, result };

        if (requiresUserConfirmation(result)) {
          const approvalId = getApprovalId(result);
          if (approvalId) {
            this.pendingApprovals.set(approvalId, {
              toolCall,
              skippedToolCalls: response.toolCalls.slice(toolCallIndex + 1),
              iteration: agentIteration,
            });
          }
          yield { type: "done", text: fullText };
          return;
        }

        this.appendToolResult(toolCall.id, result);
      }
    }

    if (this.config.maxAgentIterations > 0 && agentIteration >= maxIterations) {
      yield { type: "done", text: fullText };
    }
  }

  private async executeToolCall(
    toolCall: ToolUseBlock,
    controller: AbortController,
    actor: AgentActor | undefined,
    agentIteration: number,
  ): Promise<string> {
    // Before Tool Hook
    const beforeTool = await this.pluginManager.callOnBeforeTool(
      toolCall.name, toolCall.input, agentIteration, this.id,
    );
    if (beforeTool.abort) return JSON.stringify({ error: beforeTool.abort });

    const tool = this.pluginManager.getTool(toolCall.name);
    let result: string;
    if (tool) {
      try {
        result = await tool.execute(toolCall.input, { signal: controller.signal, sessionId: this.id, actor });
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

  private appendToolResult(toolUseId: string, result: string): void {
    const toolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: result,
    };
    const toolResultMsg: Message = { role: "user", content: [toolResult], _timestamp: Date.now() };
    appendHistory(this.workspacePath, toolResultMsg, this.id);
    this.history.push(toolResultMsg);
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
