import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import type { ModelClient } from "../../src/model/index.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { loadSessionState, saveSessionState } from "../../src/session-state.js";
import { appendSessionMessage, sessionMessagesPath } from "../../src/session-store.js";
import type { ChatResponse, Message, Tool, ToolDefinition } from "../../src/types.js";
import { FakeModelClient } from "../helpers/fake-model-client.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function registerTool(manager: PluginManager, tool: Tool): void {
  const registry = (manager as unknown as {
    registry: { register(tool: Tool): void };
  }).registry;
  registry.register(tool);
}

function addHooks(manager: PluginManager, hooks: { onError?: (ctx: unknown, error: Error) => void }): void {
  (manager as unknown as { hooks: unknown[] }).hooks.push(hooks);
}

class SummaryModelClient implements ModelClient {
  readonly calls: Message[][] = [];
  readonly completeCalls: Message[][] = [];

  constructor(private chats: ChatResponse[]) {}

  async complete(messages: Message[]): Promise<string> {
    this.completeCalls.push([...messages]);
    return "持久化摘要：用户正在验证会话记忆恢复。";
  }

  async chat(
    messages: Message[],
    onDelta: (text: string) => void,
    _tools?: ToolDefinition[],
    _systemPrompt?: string,
    _signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls.push([...messages]);
    const response = this.chats.shift();
    if (!response) throw new Error("SummaryModelClient: 没有剩余响应");
    if (response.text) onDelta(response.text);
    return response;
  }
}

describe("AgentSession loop", () => {
  let workspacePath: string;
  let manager: PluginManager;

  beforeEach(async () => {
    workspacePath = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
    });
    manager = new PluginManager(workspacePath);
    await manager.loadCorePlugins();
  });

  afterEach(async () => {
    await manager.destroy();
    removeTempWorkspace(workspacePath);
  });

  it("streams a direct model response and completes", async () => {
    const client = new FakeModelClient([{ text: "hello", toolCalls: [] }]);
    const session = new AgentSession("direct", workspacePath, manager, {}, client);

    expect(await collect(session.chat("hi"))).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "done", text: "hello" },
    ]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].messages).toEqual([
      expect.objectContaining({ role: "user", content: "hi" }),
    ]);
    expect(session.getMessages()).toEqual([
      expect.objectContaining({ role: "user", content: "hi" }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
  });

  it("executes tools and feeds the result into the next model iteration", async () => {
    registerTool(manager, {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      execute: async (args) => `echo:${String(args.text)}`,
    });
    const client = new FakeModelClient([
      {
        text: "",
        toolCalls: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "value" } }],
      },
      (messages) => {
        expect(messages.at(-1)).toEqual({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "echo:value" }],
          _timestamp: expect.any(Number),
        });
        return { text: "done", toolCalls: [] };
      },
    ]);
    const session = new AgentSession("tool-loop", workspacePath, manager, {}, client);

    expect(await collect(session.chat("run"))).toEqual([
      { type: "tool_call", name: "echo", input: { text: "value" } },
      { type: "tool_result", name: "echo", result: "echo:value" },
      { type: "text_delta", text: "done" },
      { type: "done", text: "done" },
    ]);
    expect(client.calls).toHaveLength(2);
    const records = readFileSync(sessionMessagesPath(workspacePath, "tool-loop"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "echo:value" }],
    }));
  });

  it("returns structured results for unknown tools and tool failures", async () => {
    registerTool(manager, {
      name: "fail",
      description: "fail",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("tool failed");
      },
    });
    const client = new FakeModelClient([
      {
        text: "",
        toolCalls: [
          { type: "tool_use", id: "missing", name: "missing", input: {} },
          { type: "tool_use", id: "fail", name: "fail", input: {} },
        ],
      },
      { text: "handled", toolCalls: [] },
    ]);
    const session = new AgentSession("tool-errors", workspacePath, manager, {}, client);
    const events = await collect(session.chat("run"));

    expect(events).toContainEqual({
      type: "tool_result",
      name: "missing",
      result: JSON.stringify({ error: "未知工具: missing" }),
    });
    expect(events).toContainEqual({
      type: "tool_result",
      name: "fail",
      result: JSON.stringify({ error: "工具执行失败: tool failed" }),
    });
  });

  it("pauses the loop when a tool requires user confirmation", async () => {
    const gatedTool = vi.fn(async () => JSON.stringify({
      error: "需要批准",
      requiresConfirmation: true,
      approvalId: "approval-1",
    }));
    const laterTool = vi.fn(async () => "should-not-run");
    registerTool(manager, {
      name: "gated",
      description: "gated",
      inputSchema: { type: "object", properties: {} },
      execute: gatedTool,
    });
    registerTool(manager, {
      name: "later",
      description: "later",
      inputSchema: { type: "object", properties: {} },
      execute: laterTool,
    });
    const client = new FakeModelClient([
      {
        text: "先申请授权",
        toolCalls: [
          { type: "tool_use", id: "call-1", name: "gated", input: {} },
          { type: "tool_use", id: "call-2", name: "later", input: {} },
        ],
      },
      { text: "不应该继续总结", toolCalls: [] },
    ]);
    const session = new AgentSession("approval-pause", workspacePath, manager, {}, client);

    expect(await collect(session.chat("run"))).toEqual([
      { type: "text_delta", text: "先申请授权" },
      { type: "tool_call", name: "gated", input: {} },
      {
        type: "tool_result",
        name: "gated",
        result: JSON.stringify({ error: "需要批准", requiresConfirmation: true, approvalId: "approval-1" }),
      },
      { type: "done", text: "先申请授权" },
    ]);
    expect(client.calls).toHaveLength(1);
    expect(gatedTool).toHaveBeenCalledTimes(1);
    expect(laterTool).not.toHaveBeenCalled();
  });

  it("continues the original model loop after an approval is granted", async () => {
    const gatedTool = vi.fn(async () => {
      if (gatedTool.mock.calls.length === 1) {
        return JSON.stringify({
          error: "需要批准",
          requiresConfirmation: true,
          approvalId: "approval-1",
        });
      }
      return "approved-result";
    });
    const laterTool = vi.fn(async () => "should-not-run");
    registerTool(manager, {
      name: "gated",
      description: "gated",
      inputSchema: { type: "object", properties: {} },
      execute: gatedTool,
    });
    registerTool(manager, {
      name: "later",
      description: "later",
      inputSchema: { type: "object", properties: {} },
      execute: laterTool,
    });
    const client = new FakeModelClient([
      {
        text: "需要授权",
        toolCalls: [
          { type: "tool_use", id: "call-1", name: "gated", input: {} },
          { type: "tool_use", id: "call-2", name: "later", input: {} },
        ],
      },
      (messages) => {
        expect(messages.at(-2)).toEqual({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "approved-result" }],
          _timestamp: expect.any(Number),
        });
        expect(messages.at(-1)).toEqual({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call-2",
            content: expect.stringContaining("前一个工具调用需要授权"),
          }],
          _timestamp: expect.any(Number),
        });
        return { text: "继续后的总结", toolCalls: [] };
      },
    ]);
    const session = new AgentSession("approval-resume", workspacePath, manager, {}, client);

    await collect(session.chat("run"));
    expect(await collect(session.chat("new task before approval"))).toEqual([
      { type: "error", message: "当前会话有待审批的工具调用。请先批准或拒绝最新审批，再继续发送新任务。" },
    ]);
    expect(await collect(session.resumeApproval("approval-1"))).toEqual([
      { type: "tool_call", name: "gated", input: {} },
      { type: "tool_result", name: "gated", result: "approved-result" },
      { type: "text_delta", text: "继续后的总结" },
      { type: "done", text: "继续后的总结" },
    ]);
    expect(client.calls).toHaveLength(2);
    expect(gatedTool).toHaveBeenCalledTimes(2);
    expect(laterTool).not.toHaveBeenCalled();
  });

  it("strips persisted tool chains from previous turns when restoring a session", async () => {
    appendSessionMessage(workspacePath, "restore", { role: "user", content: "legacy request" });
    appendSessionMessage(workspacePath, "restore", {
      role: "assistant",
      content: [
        { type: "text", text: "legacy text" },
        { type: "tool_use", id: "missing-result", name: "echo", input: {} },
      ],
    });
    appendSessionMessage(workspacePath, "restore", {
      role: "assistant",
      content: [{ type: "tool_use", id: "complete-result", name: "echo", input: {} }],
    });
    appendSessionMessage(workspacePath, "restore", {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "complete-result", content: "ok" }],
    });

    const client = new FakeModelClient([
      (messages) => {
        expect(messages).toEqual([
          expect.objectContaining({ role: "user", content: "legacy request" }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "legacy text" }],
          }),
          expect.objectContaining({ role: "user", content: "continue" }),
        ]);
        return { text: "done", toolCalls: [] };
      },
    ]);
    const session = new AgentSession("restore", workspacePath, manager, {}, client);

    expect(await collect(session.chat("continue"))).toEqual([
      { type: "text_delta", text: "done" },
      { type: "done", text: "done" },
    ]);
  });

  it("persists session summaries and restores them after rebuilding the session", async () => {
    const summaryWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 1, recentTurns: 1 },
    });
    const firstManager = new PluginManager(summaryWorkspace);
    const secondManager = new PluginManager(summaryWorkspace);
    try {
      await firstManager.loadCorePlugins();
      const firstClient = new SummaryModelClient([{ text: "第一轮完成", toolCalls: [] }]);
      const firstSession = new AgentSession("summary-session", summaryWorkspace, firstManager, {}, firstClient);

      expect(await collect(firstSession.chat("记住这个目标"))).toEqual([
        { type: "text_delta", text: "第一轮完成" },
        { type: "done", text: "第一轮完成" },
      ]);
      expect(loadSessionState(summaryWorkspace, "summary-session").summary).toContain("持久化摘要");

      await secondManager.loadCorePlugins();
      const secondClient = new SummaryModelClient([{ text: "第二轮完成", toolCalls: [] }]);
      const secondSession = new AgentSession("summary-session", summaryWorkspace, secondManager, {}, secondClient);

      expect(await collect(secondSession.chat("继续"))).toEqual([
        { type: "text_delta", text: "第二轮完成" },
        { type: "done", text: "第二轮完成" },
      ]);
      expect(secondClient.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("[当前会话摘要]\n持久化摘要"),
        }),
        expect.objectContaining({ role: "user", content: "记住这个目标" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "第一轮完成" }],
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
    } finally {
      await firstManager.destroy();
      await secondManager.destroy();
      removeTempWorkspace(summaryWorkspace);
    }
  });

  it("refreshes stale cached session summary state from persistent storage", async () => {
    const summaryRefreshWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 1 },
    });
    const summaryRefreshManager = new PluginManager(summaryRefreshWorkspace);
    try {
      await summaryRefreshManager.loadCorePlugins();
      const client = new SummaryModelClient([
        { text: "第一轮完成", toolCalls: [] },
        { text: "第二轮完成", toolCalls: [] },
      ]);
      const session = new AgentSession("summary-refresh-session", summaryRefreshWorkspace, summaryRefreshManager, {}, client);

      expect(await collect(session.chat("先缓存空摘要"))).toEqual([
        { type: "text_delta", text: "第一轮完成" },
        { type: "done", text: "第一轮完成" },
      ]);

      saveSessionState(summaryRefreshWorkspace, {
        sessionId: "summary-refresh-session",
        summary: "外部写入的会话摘要",
        pendingMessages: [],
        turnsSinceSummary: 0,
      });

      expect(await collect(session.chat("继续"))).toEqual([
        { type: "text_delta", text: "第二轮完成" },
        { type: "done", text: "第二轮完成" },
      ]);

      expect(client.calls[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("[当前会话摘要]\n外部写入的会话摘要"),
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
    } finally {
      await summaryRefreshManager.destroy();
      removeTempWorkspace(summaryRefreshWorkspace);
    }
  });

  it("keeps recent raw history when stale pending summary messages exist", async () => {
    const summaryRecentWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 2 },
    });
    const summaryRecentManager = new PluginManager(summaryRecentWorkspace);
    try {
      await summaryRecentManager.loadCorePlugins();
      saveSessionState(summaryRecentWorkspace, {
        sessionId: "summary-recent-session",
        summary: "已有会话摘要",
        pendingMessages: [
          { role: "user", content: "陈旧 pending 用户消息", _timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "陈旧 pending 助手消息" }], _timestamp: 2 },
        ],
        turnsSinceSummary: 2,
      });
      appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", { role: "user", content: "最近问题 A", _timestamp: 10 });
      appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", {
        role: "assistant",
        content: [{ type: "text", text: "最近回答 A" }],
        _timestamp: 11,
      });
      appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", { role: "user", content: "最近问题 B", _timestamp: 12 });
      appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", {
        role: "assistant",
        content: [{ type: "text", text: "最近回答 B" }],
        _timestamp: 13,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-recent-session", summaryRecentWorkspace, summaryRecentManager, {}, client);

      expect(await collect(session.chat("当前问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.calls[0]).toEqual([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("[当前会话摘要]\n已有会话摘要"),
        }),
        expect.objectContaining({ role: "user", content: "最近问题 A" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "最近回答 A" }],
        }),
        expect.objectContaining({ role: "user", content: "最近问题 B" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "最近回答 B" }],
        }),
        expect.objectContaining({ role: "user", content: "当前问题" }),
      ]);
      expect(client.calls[0]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: "陈旧 pending 用户消息" }),
      ]));
    } finally {
      await summaryRecentManager.destroy();
      removeTempWorkspace(summaryRecentWorkspace);
    }
  });

  it("keeps configured recent user turns after stripping tool messages", async () => {
    const summaryTurnsWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 3 },
      historyWindowSize: 20,
    });
    const summaryTurnsManager = new PluginManager(summaryTurnsWorkspace);
    try {
      await summaryTurnsManager.loadCorePlugins();
      saveSessionState(summaryTurnsWorkspace, {
        sessionId: "summary-turns-session",
        summary: "已有会话摘要",
        pendingMessages: [],
        turnsSinceSummary: 0,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", { role: "user", content: "历史问题 1", _timestamp: 1 });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [{ type: "text", text: "历史回答 1" }],
        _timestamp: 2,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", { role: "user", content: "历史问题 2", _timestamp: 3 });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [
          { type: "text", text: "我来查一下历史问题 2" },
          { type: "tool_use", id: "tool-2", name: "web_search", input: { query: "历史问题 2" } },
        ],
        _timestamp: 4,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "工具结果 2".repeat(1000) }],
        _timestamp: 5,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [{ type: "text", text: "历史回答 2" }],
        _timestamp: 6,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", { role: "user", content: "历史问题 3", _timestamp: 7 });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-3", name: "web_search", input: { query: "历史问题 3" } },
        ],
        _timestamp: 8,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-3", content: "工具结果 3".repeat(1000) }],
        _timestamp: 9,
      });
      appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [{ type: "text", text: "历史回答 3" }],
        _timestamp: 10,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-turns-session", summaryTurnsWorkspace, summaryTurnsManager, {}, client);

      expect(await collect(session.chat("当前问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "历史问题 1" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "历史回答 1" }],
        }),
        expect.objectContaining({ role: "user", content: "历史问题 2" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "我来查一下历史问题 2" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "历史回答 2" }],
        }),
        expect.objectContaining({ role: "user", content: "历史问题 3" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "历史回答 3" }],
        }),
        expect.objectContaining({ role: "user", content: "当前问题" }),
      ]));
      expect(client.calls[0]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool_result" }),
          ]),
        }),
      ]));
    } finally {
      await summaryTurnsManager.destroy();
      removeTempWorkspace(summaryTurnsWorkspace);
    }
  });

  it("does not reintroduce previous tool messages from pending session summary state", async () => {
    const summaryToolWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 2 },
    });
    const summaryToolManager = new PluginManager(summaryToolWorkspace);
    try {
      await summaryToolManager.loadCorePlugins();
      saveSessionState(summaryToolWorkspace, {
        sessionId: "summary-tool-session",
        summary: "已有会话摘要",
        pendingMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "我来查一下" },
              { type: "tool_use", id: "tool-1", name: "web_search", input: { query: "large" } },
            ],
            _timestamp: 20,
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "巨大工具结果".repeat(1000) }],
            _timestamp: 21,
          },
        ],
        turnsSinceSummary: 2,
      });
      appendSessionMessage(summaryToolWorkspace, "summary-tool-session", { role: "user", content: "最近问题", _timestamp: 10 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-tool-session", summaryToolWorkspace, summaryToolManager, {}, client);

      expect(await collect(session.chat("当前问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "我来查一下" }],
        }),
      ]));
      expect(client.calls[0]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool_result" }),
          ]),
        }),
      ]));
    } finally {
      await summaryToolManager.destroy();
      removeTempWorkspace(summaryToolWorkspace);
    }
  });

  it("preserves recent raw messages when context compression summarizes old history", async () => {
    const compressWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false, recentTurns: 1 },
      maxContextTokens: 100,
      contextCompressionThreshold: 0.1,
      historyWindowSize: 10,
    });
    const compressManager = new PluginManager(compressWorkspace);
    try {
      await compressManager.loadCorePlugins();
      const oldText = "旧历史内容".repeat(40);
      appendSessionMessage(compressWorkspace, "compress-session", { role: "user", content: `old user ${oldText}`, _timestamp: 1 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "assistant", content: [{ type: "text", text: `old assistant ${oldText}` }], _timestamp: 2 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "user", content: `older user ${oldText}`, _timestamp: 3 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "assistant", content: [{ type: "text", text: `older assistant ${oldText}` }], _timestamp: 4 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "user", content: "recent user raw", _timestamp: 5 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "assistant", content: [{ type: "text", text: "recent assistant raw" }], _timestamp: 6 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("compress-session", compressWorkspace, compressManager, {}, client);

      expect(await collect(session.chat("current user raw"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.completeCalls[0][0].content).toContain("不超过 5000 字");
      expect(client.calls[0]).toEqual([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("[以下是对话历史的摘要]"),
        }),
        expect.objectContaining({ role: "user", content: "recent user raw" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "recent assistant raw" }],
        }),
        expect.objectContaining({ role: "user", content: "current user raw" }),
      ]);
    } finally {
      await compressManager.destroy();
      removeTempWorkspace(compressWorkspace);
    }
  });

  it("uses configured context compression summary length", async () => {
    const compressLengthWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false, recentTurns: 1 },
      maxContextTokens: 100,
      contextCompressionThreshold: 0.1,
      contextCompressionMaxChars: 1200,
      historyWindowSize: 10,
    });
    const compressLengthManager = new PluginManager(compressLengthWorkspace);
    try {
      await compressLengthManager.loadCorePlugins();
      const oldText = "旧历史内容".repeat(40);
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "user", content: `old user ${oldText}`, _timestamp: 1 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "assistant", content: [{ type: "text", text: `old assistant ${oldText}` }], _timestamp: 2 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "user", content: `older user ${oldText}`, _timestamp: 3 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "assistant", content: [{ type: "text", text: `older assistant ${oldText}` }], _timestamp: 4 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "user", content: "recent user raw", _timestamp: 5 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "assistant", content: [{ type: "text", text: "recent assistant raw" }], _timestamp: 6 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("compress-length-session", compressLengthWorkspace, compressLengthManager, {}, client);

      expect(await collect(session.chat("current user raw"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.completeCalls[0][0].content).toContain("不超过 1200 字");
    } finally {
      await compressLengthManager.destroy();
      removeTempWorkspace(compressLengthWorkspace);
    }
  });

  it("does not summarize an injected session summary again during context compression", async () => {
    const summaryCompressWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 1 },
      maxContextTokens: 10,
      contextCompressionThreshold: 0.1,
      historyWindowSize: 10,
    });
    const summaryCompressManager = new PluginManager(summaryCompressWorkspace);
    try {
      await summaryCompressManager.loadCorePlugins();
      saveSessionState(summaryCompressWorkspace, {
        sessionId: "summary-compress-session",
        summary: "已有滚动摘要，不应该被再次摘要。",
        pendingMessages: [],
        turnsSinceSummary: 0,
      });
      appendSessionMessage(summaryCompressWorkspace, "summary-compress-session", { role: "user", content: "recent user raw", _timestamp: 1 });
      appendSessionMessage(summaryCompressWorkspace, "summary-compress-session", {
        role: "assistant",
        content: [{ type: "text", text: "recent assistant raw" }],
        _timestamp: 2,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-compress-session", summaryCompressWorkspace, summaryCompressManager, {}, client);

      expect(await collect(session.chat("current user raw"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.completeCalls).toHaveLength(0);
      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("[当前会话摘要]\n已有滚动摘要"),
        }),
        expect.objectContaining({ role: "user", content: "recent user raw" }),
        expect.objectContaining({ role: "user", content: "current user raw" }),
      ]));
    } finally {
      await summaryCompressManager.destroy();
      removeTempWorkspace(summaryCompressWorkspace);
    }
  });

  it("coalesces repeated synthetic summaries before sending context to the model", async () => {
    const summaryNormalizeWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
      maxContextTokens: 128_000,
      contextCompressionThreshold: 0.7,
      historyWindowSize: 20,
    });
    const summaryNormalizeManager = new PluginManager(summaryNormalizeWorkspace);
    try {
      await summaryNormalizeManager.loadCorePlugins();
      appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "user", content: "[当前会话摘要]\n旧会话摘要", _timestamp: 1 });
      appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "user", content: "[以下是对话历史的摘要]\n较早历史摘要", _timestamp: 2 });
      appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "user", content: "[以下是对话历史的摘要]\n最新历史摘要", _timestamp: 3 });
      appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "assistant", content: [{ type: "text", text: "上一轮最终回答" }], _timestamp: 4 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-normalize-session", summaryNormalizeWorkspace, summaryNormalizeManager, {}, client);

      expect(await collect(session.chat("继续"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      const syntheticSummaries = client.calls[0].filter((message) => typeof message.content === "string"
        && (message.content.startsWith("[当前会话摘要]") || message.content.startsWith("[以下是对话历史的摘要]")));
      expect(syntheticSummaries).toEqual([
        expect.objectContaining({ content: "[当前会话摘要]\n旧会话摘要" }),
        expect.objectContaining({ content: "[以下是对话历史的摘要]\n最新历史摘要" }),
      ]);
      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "上一轮最终回答" }],
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
      expect(client.completeCalls).toHaveLength(0);
    } finally {
      await summaryNormalizeManager.destroy();
      removeTempWorkspace(summaryNormalizeWorkspace);
    }
  });

  it("does not compress tool results from previous turns after a new user message", async () => {
    const previousToolWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
      maxContextTokens: 100,
      contextCompressionThreshold: 0.1,
      historyWindowSize: 10,
    });
    const previousToolManager = new PluginManager(previousToolWorkspace);
    try {
      await previousToolManager.loadCorePlugins();
      appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "user",
        content: "上一轮搜索",
        _timestamp: 1,
      });
      appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "assistant",
        content: [
          { type: "text", text: "我来搜索" },
          { type: "tool_use", id: "search-1", name: "web_search", input: { query: "large" } },
        ],
        _timestamp: 2,
      });
      appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "search-1", content: "上一轮巨大工具结果".repeat(20_000) }],
        _timestamp: 3,
      });
      appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "assistant",
        content: [{ type: "text", text: "上一轮最终回答" }],
        _timestamp: 4,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("previous-tool-session", previousToolWorkspace, previousToolManager, {}, client);

      expect(await collect(session.chat("新一轮问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      expect(client.completeCalls).toHaveLength(0);
      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "上一轮搜索" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "我来搜索" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "上一轮最终回答" }],
        }),
        expect.objectContaining({ role: "user", content: "新一轮问题" }),
      ]));
      expect(client.calls[0]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool_result" }),
          ]),
        }),
      ]));
    } finally {
      await previousToolManager.destroy();
      removeTempWorkspace(previousToolWorkspace);
    }
  });

  it("truncates oversized recent tool results before sending context to the model", async () => {
    const toolBudgetWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
      maxContextTokens: 20_000,
      contextCompressionThreshold: 0.5,
      toolResultInitialMaxChars: 4000,
      historyWindowSize: 10,
    });
    const toolBudgetManager = new PluginManager(toolBudgetWorkspace);
    try {
      await toolBudgetManager.loadCorePlugins();
      registerTool(toolBudgetManager, {
        name: "large_result",
        description: "returns a large result",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "超大搜索结果".repeat(20_000),
      });

      const client = new SummaryModelClient([
        { text: "", toolCalls: [{ type: "tool_use", id: "search-1", name: "large_result", input: {} }] },
        { text: "完成", toolCalls: [] },
      ]);
      const session = new AgentSession("tool-budget-session", toolBudgetWorkspace, toolBudgetManager, {}, client);

      expect(await collect(session.chat("继续总结"))).toEqual([
        { type: "tool_call", name: "large_result", input: {} },
        { type: "tool_result", name: "large_result", result: "超大搜索结果".repeat(20_000) },
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成" },
      ]);

      const toolResultMessage = client.calls[1].find((message) => Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result"));
      expect(toolResultMessage).toBeDefined();
      const toolResult = (toolResultMessage!.content as Array<{ type: string; content?: string }>)
        .find((block) => block.type === "tool_result");
      expect(toolResult?.content).toContain("[工具结果已截断");
      expect(toolResult?.content?.length).toBeLessThan(5_000);
    } finally {
      await toolBudgetManager.destroy();
      removeTempWorkspace(toolBudgetWorkspace);
    }
  });

  it("returns an error event when the model call fails", async () => {
    const onError = vi.fn();
    addHooks(manager, { onError });
    const client = new FakeModelClient([new Error("model unavailable")]);
    const session = new AgentSession("model-error", workspacePath, manager, {}, client);

    expect(await collect(session.chat("hi"))).toEqual([
      { type: "error", message: "model unavailable" },
    ]);
    expect(onError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: "model unavailable" }));
  });

  it("rejects concurrent chats in the same session and supports cancellation", async () => {
    const client = new FakeModelClient([
      (_messages, _tools, _systemPrompt, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    const session = new AgentSession("cancel", workspacePath, manager, {}, client);
    const running = collect(session.chat("wait"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.isBusy()).toBe(true);
    expect(await collect(session.chat("second"))).toEqual([
      { type: "error", message: "会话正在执行中，请等待完成或先取消当前任务" },
    ]);
    expect(session.cancel()).toBe(true);
    expect(await running).toEqual([{ type: "error", message: "会话已取消" }]);
    expect(session.isBusy()).toBe(false);
    expect(session.cancel()).toBe(false);
  });

  it("stops after the configured maximum number of iterations", async () => {
    registerTool(manager, {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "ok",
    });
    const client = new FakeModelClient([
      {
        text: "partial",
        toolCalls: [{ type: "tool_use", id: "call-1", name: "echo", input: {} }],
      },
    ]);
    const session = new AgentSession("limited", workspacePath, manager, {
      maxAgentIterations: 1,
    }, client);

    expect(await collect(session.chat("hi"))).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "tool_call", name: "echo", input: {} },
      { type: "tool_result", name: "echo", result: "ok" },
      { type: "done", text: "partial" },
    ]);
  });
});
