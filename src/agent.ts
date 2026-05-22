import { loadConfig } from "./config.js";
import { AnthropicClient } from "./client.js";
import { MessageHistory } from "./history.js";
import { ToolRegistry } from "./tools/registry.js";
import { createWebSearchTool } from "./tools/search.js";
import { createWebFetchTool } from "./tools/web_fetch.js";
import { createBashTool } from "./tools/bash.js";
import { createFileReadTool } from "./tools/file_read.js";
import { createFileWriteTool } from "./tools/file_write.js";
import { createFileEditTool } from "./tools/file_edit.js";
import { createMemorySaveTool, createMemoryAppendTool, createMemoryListTool } from "./tools/memory.js";
import { createSkillUseTool, createSkillListTool } from "./tools/skill.js";
import { ensureWorkspace } from "./workspace/workspace.js";
import { buildSystemPrompt } from "./prompts/build.js";
import { appendHistory, appendLog } from "./workspace/logger.js";
import { compressIfNeeded } from "./compress.js";
import type { Config, Message, ToolUseBlock, ToolResultBlock } from "./types.js";

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

// === AgentSession ===

export class AgentSession {
  readonly id: string;
  private config: Config;
  private client: AnthropicClient;
  private history: MessageHistory;
  private registry: ToolRegistry;
  private systemPrompt: string;
  private workspacePath: string;
  lastActivity: number;

  getMessages(): Message[] {
    return this.history.getRecentMessages(Infinity);
  }

  constructor(id: string, workspacePath: string) {
    this.id = id;
    this.workspacePath = workspacePath;
    ensureWorkspace(workspacePath);

    this.config = loadConfig(workspacePath);
    this.client = new AnthropicClient(this.config);
    this.history = new MessageHistory();
    this.lastActivity = Date.now();

    this.registry = new ToolRegistry();
    this.registry.register(createWebSearchTool(this.config));
    this.registry.register(createWebFetchTool());
    this.registry.register(createBashTool());
    this.registry.register(createFileReadTool());
    this.registry.register(createFileWriteTool());
    this.registry.register(createFileEditTool());
    this.registry.register(createMemorySaveTool(workspacePath));
    this.registry.register(createMemoryAppendTool(workspacePath));
    this.registry.register(createMemoryListTool(workspacePath));
    this.registry.register(createSkillUseTool(workspacePath));
    this.registry.register(createSkillListTool(workspacePath));

    this.systemPrompt = buildSystemPrompt(workspacePath, this.registry.getDefinitions());
  }

  /** 执行一轮对话，返回事件流 */
  async *chat(userInput: string): AsyncGenerator<AgentEvent> {
    this.lastActivity = Date.now();

    const userMsg: Message = { role: "user", content: userInput };
    appendHistory(this.workspacePath, userMsg, this.id);
    appendLog(this.workspacePath, "INFO", `用户输入: ${userInput}`, this.id);
    this.history.markTurnStart();
    this.history.push(userMsg);

    const maxIterations = this.config.maxAgentIterations > 0 ? this.config.maxAgentIterations : Infinity;
    let agentIteration = 0;
    let fullText = "";

    while (agentIteration < maxIterations) {
      agentIteration++;
      const context = this.history.getRecentMessages(this.config.historyWindowSize);
      const turnStartIdx = this.history.getTurnStartIndexInContext(this.config.historyWindowSize);

      // 上下文压缩
      const compressed = await compressIfNeeded(context, this.config, this.client, turnStartIdx);
      if (compressed !== context) {
        const estimatedTurnStart = compressed.length - (context.length - turnStartIdx);
        this.history.replaceWithCompressed(compressed, Math.max(0, estimatedTurnStart));
        appendLog(this.workspacePath, "INFO", `上下文已压缩: ${context.length} → ${compressed.length} 条消息`, this.id);
      }

      const toolDefs = this.registry.getDefinitions();

      // 流式调用：onDelta 实时推入事件队列，chatPromise 返回完整响应
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
      ).then(
        (response) => {
          eventQueue.close();
          return response;
        },
        (err) => {
          chatError = err instanceof Error ? err.message : String(err);
          appendLog(this.workspacePath, "ERROR", `API 请求失败: ${chatError}`, this.id);
          eventQueue.close();
          return null;
        },
      );

      // 实时消费 text_delta 事件
      let item = await eventQueue.next();
      while (!item.done) {
        yield item.value;
        item = await eventQueue.next();
      }

      // 等待 chat 完成
      const response = await chatPromise;

      if (chatError || !response) {
        yield { type: "error", message: chatError || "未知错误" };
        return;
      }

      // 构造 assistant 消息
      const assistantContent: (ToolUseBlock | { type: "text"; text: string })[] = [];
      if (response.text) {
        assistantContent.push({ type: "text", text: response.text });
      }
      for (const tc of response.toolCalls) {
        assistantContent.push(tc);
      }

      if (assistantContent.length > 0) {
        const assistantMsg: Message = { role: "assistant", content: assistantContent };
        appendHistory(this.workspacePath, assistantMsg, this.id);
        if (response.text) {
          appendLog(this.workspacePath, "INFO", `Assistant: ${response.text.slice(0, 200)}`, this.id);
        }
        this.history.push(assistantMsg);
      }

      // 无工具调用，结束
      if (response.toolCalls.length === 0) {
        yield { type: "done", text: fullText };
        return;
      }

      // 执行工具调用
      for (const toolCall of response.toolCalls) {
        yield { type: "tool_call", name: toolCall.name, input: toolCall.input };
        appendLog(this.workspacePath, "TOOL", `调用: ${toolCall.name}(${JSON.stringify(toolCall.input)})`, this.id);

        const tool = this.registry.getTool(toolCall.name);
        let result: string;
        if (tool) {
          try {
            result = await tool.execute(toolCall.input);
            appendLog(this.workspacePath, "TOOL", `结果: ${result.slice(0, 500)}`, this.id);
          } catch (err) {
            result = JSON.stringify({
              error: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
            });
            appendLog(this.workspacePath, "ERROR", `工具执行失败: ${err instanceof Error ? err.message : String(err)}`, this.id);
          }
        } else {
          result = JSON.stringify({ error: `未知工具: ${toolCall.name}` });
          appendLog(this.workspacePath, "ERROR", `未知工具: ${toolCall.name}`, this.id);
        }

        yield { type: "tool_result", name: toolCall.name, result };

        const toolResult: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result,
        };
        const toolResultMsg: Message = { role: "user", content: [toolResult] };
        appendHistory(this.workspacePath, toolResultMsg, this.id);
        this.history.push(toolResultMsg);
      }
    }

    if (this.config.maxAgentIterations > 0 && agentIteration >= maxIterations) {
      appendLog(this.workspacePath, "WARN", "Agent Loop 达到最大迭代次数限制", this.id);
      yield { type: "done", text: fullText };
    }
  }
}
