import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { attachmentToImageBlock, saveAttachment } from "../../src/attachments.js";
import { loadConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/model/index.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { loadSessionState, saveSessionState, updateSessionState } from "../../src/session-state.js";
import { appendSessionMessage, readSessionMessages, createSessionMeta, sessionDir, sessionMessagesPath, sessionStateFilePath } from "../../src/session-store.js";
import { getMemoryRecord, saveMemory } from "../../src/tools/memory.js";
import { approveRequest, approveTurnRequest, hasTurnApproval, listApprovals, listSessionApprovalContinuations } from "../../src/tools/approval.js";
import { checkDangerousToolPermission } from "../../src/tools/permission.js";
import type { ChatResponse, Message, Tool, ToolDefinition } from "../../src/types.js";
import { runAutoMemoryAnalysis, runWorkspaceAutoMemoryAnalysis } from "../../src/plugins/core/auto-memory.js";
import type { PluginContext, PluginHooks } from "../../src/plugins/types.js";
import { loadSessionSummary } from "../../src/session-memory/store.js";
import { readRun } from "../../src/run-store.js";
import { FakeModelClient } from "../helpers/fake-model-client.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) {
    if (event.type !== "context_usage" && event.type !== "run_state") result.push(event);
  }
  return result;
}

async function collectAll(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function registerTool(manager: PluginManager, tool: Tool): void {
  createPluginContext(manager).registerTool(tool);
}

function addHooks(manager: PluginManager, hooks: PluginHooks): void {
  createPluginContext(manager).registerHooks(hooks);
}

function createPluginContext(manager: PluginManager): PluginContext {
  return (manager as unknown as {
    createPluginContext: (name: string) => PluginContext;
  }).createPluginContext("test-agent-loop");
}

class SummaryModelClient implements ModelClient {
  readonly calls: Message[][] = [];
  readonly completeCalls: Message[][] = [];
  readonly systemPrompts: (string | undefined)[] = [];

  constructor(private chats: ChatResponse[]) {}

  async complete(messages: Message[]): Promise<string> {
    this.completeCalls.push([...messages]);
    const content = String(messages[0]?.content ?? "");
    try {
      const payload = JSON.parse(content) as {
        task?: string;
        schema?: { baseRevision: number; sourceRange: { fromSequence: number; throughSequence: number } };
        messages?: Array<{ messageId: string }>;
      };
      if (payload.task === "生成会话摘要 Delta" && payload.schema && payload.messages?.[0]) {
        return JSON.stringify({
          baseRevision: payload.schema.baseRevision,
          sourceRange: payload.schema.sourceRange,
          operations: [{
            type: "add",
            category: "goals",
            item: {
              text: "持久化摘要：用户正在验证会话记忆恢复。",
              sourceMessageIds: [payload.messages[0].messageId],
            },
          }],
        });
      }
    } catch {
      // 上下文压缩请求不是 JSON，继续返回自由文本临时摘要。
    }
    return "持久化摘要：用户正在验证会话记忆恢复。";
  }

  async chat(
    messages: Message[],
    onDelta: (text: string) => void,
    _tools?: ToolDefinition[],
    systemPrompt?: string,
    _signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls.push([...messages]);
    this.systemPrompts.push(systemPrompt);
    const response = this.chats.shift();
    if (!response) throw new Error("SummaryModelClient: 没有剩余响应");
    if (response.text) onDelta(response.text);
    return response;
  }
}

class AutoMemoryModelClient implements ModelClient {
  readonly calls: Message[][] = [];
  readonly completeCalls: Message[][] = [];
  readonly toolDefinitions: (ToolDefinition[] | undefined)[] = [];
  readonly systemPrompts: (string | undefined)[] = [];

  constructor(
    private chats: ChatResponse[],
    private completes: string[] = [],
  ) {}

  async complete(messages: Message[]): Promise<string> {
    this.completeCalls.push([...messages]);
    const response = this.completes.shift();
    if (response === undefined) throw new Error("AutoMemoryModelClient: 没有剩余 complete 响应");
    return response;
  }

  async chat(
    messages: Message[],
    onDelta: (text: string) => void,
    _tools?: ToolDefinition[],
    _systemPrompt?: string,
    _signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls.push([...messages]);
    this.toolDefinitions.push(_tools);
    this.systemPrompts.push(_systemPrompt);
    const response = this.chats.shift();
    if (!response) throw new Error("AutoMemoryModelClient: 没有剩余 chat 响应");
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

  it("reminds silent tool loops without persisting reminders or changing the system prefix", async () => {
    registerTool(manager, { name: "progress_probe", description: "read", effect: "read", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" });
    const client = new FakeModelClient([
      ...Array.from({ length: 5 }, (_, i): ChatResponse => ({ text: "", toolCalls: [{ type: "tool_use", id: `p${i}`, name: "progress_probe", input: {} }] })),
      { text: "已完成检查，结论如下。", toolCalls: [] },
    ]);
    const session = new AgentSession("progress-loop", workspacePath, manager, {}, client);
    const events = await collect(session.chat("检查项目"));
    expect(client.calls).toHaveLength(6);
    expect(client.calls[5].messages.at(-1)?.content).toContain("执行进展提醒");
    expect(client.calls[5].systemPrompt).toBe(client.calls[0].systemPrompt);
    expect(events).toContainEqual({ type: "text_delta", text: "已完成检查，结论如下。" });
    const saved = JSON.stringify(readSessionMessages(workspacePath, "progress-loop"));
    expect(saved).toContain("已完成检查");
    expect(saved).not.toContain("执行进展提醒");
  });

  it("streams a direct model response and completes", async () => {
    const client = new FakeModelClient([{ text: "hello", toolCalls: [] }]);
    const session = new AgentSession("direct", workspacePath, manager, {}, client);

    expect(await collect(session.chat("hi"))).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "done", text: "hello", reason: "completed" },
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

  it("emits a notification event for notifiable turn end reasons", async () => {
    const notificationsWorkspace = createTempWorkspace({ notifications: { enabled: true } });
    const notificationsManager = new PluginManager(notificationsWorkspace);
    await notificationsManager.loadCorePlugins();
    try {
      const client = new FakeModelClient([{ text: "hello", toolCalls: [] }]);
      const session = new AgentSession("notify", notificationsWorkspace, notificationsManager, {}, client);

      const events = await collect(session.chat("hi"));
      expect(events).toEqual([
        { type: "text_delta", text: "hello" },
        { type: "notification", notification: { title: "本轮完成", body: "Breeze Coder 已完成本轮任务，可回来查看结果", sessionId: "notify", turnId: expect.any(String) } },
        { type: "done", text: "hello", reason: "completed" },
      ]);
    } finally {
      await notificationsManager.destroy();
      removeTempWorkspace(notificationsWorkspace);
    }
  });

  it("publishes observable model and tool activity and clears it at completion", async () => {
    registerTool(manager, {
      name: "activity_test", description: "test", inputSchema: { type: "object", properties: {} },
      execute: async (_args, context) => { context?.reportActivity?.("正在读取测试数据"); return "ok"; },
    });
    const client = new FakeModelClient([
      { text: "", toolCalls: [{ type: "tool_use", id: "activity-call", name: "activity_test", input: {} }] },
      { text: "完成", toolCalls: [] },
    ]);
    const session = new AgentSession("activity-test", workspacePath, manager, {}, client);
    const events = await collectAll(session.chat("开始"));
    const runs = events.filter((event) => event.type === "run_state").map((event) => event.run);
    expect(runs.flatMap((run) => run.status ? [run.status.stage] : [])).toEqual([
      "execution:preparing", "execution:preparing", "execution:model_wait", "execution:tool_check", "execution:tool_running", "execution:tool_finished",
      "execution:preparing", "execution:model_wait", "execution:model_output",
    ]);
    expect(runs.find((run) => run.status?.stage === "execution:tool_running")?.status).toMatchObject({ message: "正在读取测试数据", startedAt: expect.any(Number) });
    expect(runs.at(-1)).toMatchObject({ state: "completed", status: undefined });
  });

  it("emits context usage before invoking the model", async () => {
    const client = new FakeModelClient([{ text: "hello", toolCalls: [] }]);
    const session = new AgentSession("context-usage", workspacePath, manager, {}, client);

    const events = await collectAll(session.chat("hi"));
    expect(events.find((event) => event.type !== "run_state")).toEqual(expect.objectContaining({
      type: "context_usage",
      iteration: 1,
      attempt: 1,
      usage: expect.objectContaining({
        input: expect.any(Number),
        maxContext: 128000,
        outputReserved: 16384,
      }),
    }));
  });

  it("retries a successful empty model response before completing", async () => {
    const client = new FakeModelClient([
      { text: "", toolCalls: [] },
      { text: "重试后回复", toolCalls: [] },
    ]);
    const session = new AgentSession("empty-response-retry", workspacePath, manager, {}, client);

    expect(await collect(session.chat("hi"))).toEqual([
      { type: "text_delta", text: "重试后回复" },
      { type: "done", text: "重试后回复", reason: "completed" },
    ]);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].systemPrompt).toContain("上一次模型响应为空");
  });

  it("reports an error after empty model response retries are exhausted", async () => {
    const emptyWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
      emptyResponseRetries: 1,
    });
    const emptyManager = new PluginManager(emptyWorkspace);
    await emptyManager.loadCorePlugins();
    try {
      const client = new FakeModelClient([
        { text: "", toolCalls: [] },
        { text: "", toolCalls: [] },
      ]);
      const session = new AgentSession("empty-response-error", emptyWorkspace, emptyManager, {}, client);
      expect(await collect(session.chat("hi"))).toEqual([
        { type: "error", message: "模型连续 2 次返回空响应，任务已停止，请重试或更换模型。" },
      ]);
    } finally {
      await emptyManager.destroy();
      removeTempWorkspace(emptyWorkspace);
    }
  });

  it("persists image blocks from user messages and restores them after session reload", async () => {
    const png = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
    ]);
    const attachment = saveAttachment(workspacePath, "image-history", "screen.png", "image/png", png);
    const imageBlock = attachmentToImageBlock(attachment);
    const client = new FakeModelClient([{ text: "图片已识别", toolCalls: [] }]);
    const session = new AgentSession("image-history", workspacePath, manager, {}, client);

    await collect(session.chat("识别图片", undefined, [
      { type: "text", text: "识别图片" },
      imageBlock,
    ]));

    const records = readFileSync(sessionMessagesPath(workspacePath, "image-history"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.role === "user")).toEqual([
      expect.objectContaining({
        content: [
          { type: "text", text: "识别图片" },
          imageBlock,
        ],
      }),
    ]);

    const restored = new AgentSession(
      "image-history",
      workspacePath,
      manager,
      {},
      new FakeModelClient([]),
    );
    expect(restored.getMessages()).toContainEqual(expect.objectContaining({
      role: "user",
      content: [
        { type: "text", text: "识别图片" },
        imageBlock,
      ],
    }));
  });

  it("reports a clear error before model invocation when API key is empty", async () => {
    const emptyKeyWorkspace = createTempWorkspace({ apiKey: "" });
    const emptyKeyManager = new PluginManager(emptyKeyWorkspace);
    await emptyKeyManager.loadCorePlugins();
    const client = new FakeModelClient([{ text: "should not run", toolCalls: [] }]);
    const session = new AgentSession("missing-api-key", emptyKeyWorkspace, emptyKeyManager, {}, client);

    try {
      expect(await collect(session.chat("hello"))).toEqual([
        { type: "error", message: "尚未配置模型 API Key，请先在配置页面填写并保存。" },
      ]);
      expect(client.calls).toHaveLength(0);
    } finally {
      await emptyKeyManager.destroy();
      removeTempWorkspace(emptyKeyWorkspace);
    }
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
      { type: "tool_call", toolCallId: "call-1", name: "echo", input: { text: "value" }, startedAt: expect.any(Number) },
      { type: "tool_result", toolCallId: "call-1", name: "echo", result: "echo:value", completedAt: expect.any(Number) },
      { type: "text_delta", text: "done" },
      { type: "done", text: "done", reason: "completed" },
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


  it("auto-memory analyzes only user questions and final answers", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 1 },
      memory: { maxItemChars: 1000, maxTotalChars: 5000 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      registerTool(autoManager, {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "工具过程结果",
      });
      const client = new AutoMemoryModelClient([
        { text: "", toolCalls: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "value" } }] },
        { text: "最终回答：长期结论", toolCalls: [] },
        { text: "无需更新长期记忆。", toolCalls: [] },
      ]);
      const session = new AgentSession("auto-memory-input", autoWorkspace, autoManager, {}, client);

      expect(await collect(session.chat("用户原始问题"))).toEqual([
        { type: "tool_call", toolCallId: "call-1", name: "echo", input: { text: "value" }, startedAt: expect.any(Number) },
        { type: "tool_result", toolCallId: "call-1", name: "echo", result: "工具过程结果", completedAt: expect.any(Number) },
        { type: "text_delta", text: "最终回答：长期结论" },
        { type: "done", text: "最终回答：长期结论", reason: "completed" },
      ]);

      expect(client.completeCalls).toHaveLength(0);
      expect(client.systemPrompts[2]).toContain("分别维护用户 Profile 和向量长期记忆");
      expect(client.systemPrompts[2]).toContain("新事实明确替代旧状态时");
      expect(client.systemPrompts[2]).toContain("不要静默覆盖历史");
      expect(client.systemPrompts[2]).toContain("已有记忆过长、重复、碎片化");
      expect(client.systemPrompts[2]).toContain("不要因为“暂时没提到”就删除");
      const prompt = String(client.calls[2][0].content);
      expect(prompt).toContain("单条记忆正文最大字符数：1000");
      expect(prompt).toContain("当前已保存的长期记忆摘要索引：");
      expect(prompt).toContain("暂无已保存长期记忆。");
      expect(prompt).toContain("[user] 用户原始问题");
      expect(prompt).toContain("[assistant] 最终回答：长期结论");
      expect(prompt).not.toContain("工具过程结果");
      expect(prompt).not.toContain("tool_use");
      expect(prompt).not.toContain("[工具调用");
      expect(client.toolDefinitions[2]?.map((tool) => tool.name).sort()).toEqual([
        "memory_delete",
        "memory_list",
        "memory_read",
        "memory_save",
        "memory_search",
        "profile_delete",
        "profile_list",
        "profile_read",
        "profile_save",
      ]);
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("forces automatic memory writes into the analyzed project scope", async () => {
    const autoWorkspace = createTempWorkspace({ autoMemory: { enabled: true, mode: "auto" } });
    let executedInput: Record<string, unknown> | undefined;
    let executedContext: Parameters<Tool["execute"]>[1];
    const memorySave: Tool = {
      name: "memory_save",
      description: "save",
      inputSchema: { type: "object", properties: {} },
      execute: async (input, context) => {
        executedInput = input;
        executedContext = context;
        return "已保存";
      },
    };
    const client = new AutoMemoryModelClient([
      { text: "", toolCalls: [{ type: "tool_use", id: "save-1", name: "memory_save", input: {
        name: "project-rule", content: "rule", scope: "global",
      } }] },
      { text: "已整理", toolCalls: [] },
    ]);
    try {
      await runAutoMemoryAnalysis({
        workspacePath: autoWorkspace,
        config: loadConfig(autoWorkspace),
        client,
        sessionId: "project-session",
        memoryScope: "project:/repo/current",
        turns: [{ id: "turn-1", user: "记住项目规则", assistant: "好的", at: new Date().toISOString() }],
        getToolDefinitions: () => [{ name: "memory_save", description: "save", input_schema: { type: "object", properties: {} } }],
        getTool: (name) => name === "memory_save" ? memorySave : undefined,
      });
      expect(executedInput).toMatchObject({ scope: "project:/repo/current", source: "auto" });
      expect(executedContext?.sessionContext).toEqual({
        mode: "project",
        project: { root: "/repo/current", name: "current" },
      });
    } finally {
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("analyzes pending turns from different memory scopes in separate batches", async () => {
    const autoWorkspace = createTempWorkspace({ autoMemory: { enabled: true, mode: "suggest" } });
    createSessionMeta(autoWorkspace, "global-session", { mode: "chat" });
    createSessionMeta(autoWorkspace, "project-session", {
      mode: "project",
      project: { root: "/repo/current", name: "current" },
    });
    for (const [sessionId, memoryScope, user] of [
      ["global-session", "global", "全局偏好"],
      ["project-session", "project:/repo/current", "项目规则"],
    ] as const) {
      saveSessionState(autoWorkspace, {
        sessionId,
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{ id: `${sessionId}-turn`, user, assistant: "确认", at: new Date().toISOString(), memoryScope }],
          turnsSinceAnalysis: 1,
        },
      });
    }
    const memoryList: Tool = {
      name: "memory_list", description: "list", effect: "read",
      inputSchema: { type: "object", properties: {} }, execute: async () => "暂无记忆",
    };
    const client = new AutoMemoryModelClient([
      { text: "全局完成", toolCalls: [] },
      { text: "项目完成", toolCalls: [] },
    ]);
    try {
      await runWorkspaceAutoMemoryAnalysis({
        workspacePath: autoWorkspace,
        config: loadConfig(autoWorkspace),
        client,
        triggerSessionId: "global-session",
        getToolDefinitions: () => [{ name: "memory_list", description: "list", input_schema: { type: "object", properties: {} } }],
        getTool: (name) => name === "memory_list" ? memoryList : undefined,
      });
      expect(client.calls).toHaveLength(2);
      const prompts = client.calls.map((messages) => String(messages[0].content));
      expect(prompts).toEqual(expect.arrayContaining([
        expect.stringContaining("当前记忆作用域：global"),
        expect.stringContaining("当前记忆作用域：project:/repo/current"),
      ]));
      expect(prompts.every((prompt) => !(prompt.includes("全局偏好") && prompt.includes("项目规则")))).toBe(true);
      expect(loadSessionState(autoWorkspace, "global-session").autoMemory.pendingTurns).toHaveLength(0);
      expect(loadSessionState(autoWorkspace, "project-session").autoMemory.pendingTurns).toHaveLength(0);
    } finally {
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("finishes the chat before background auto-memory completes and logs its lifecycle", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "suggest", turnThreshold: 1 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    let releaseAnalysis!: () => void;
    let analysisStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      analysisStarted = resolveStarted;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseAnalysis = resolveRelease;
    });
    let calls = 0;
    const client: ModelClient = {
      complete: async () => "",
      chat: async (_messages, onDelta) => {
        calls += 1;
        if (calls === 1) {
          onDelta("最终回答");
          return { text: "最终回答", toolCalls: [] };
        }
        analysisStarted();
        await release;
        return { text: "无需更新", toolCalls: [] };
      },
    };

    try {
      await autoManager.loadCorePlugins();
      const session = new AgentSession("auto-memory-background", autoWorkspace, autoManager, {}, client);

      const events = await collect(session.chat("需要记住的问题"));
      expect(events.at(-1)).toEqual({ type: "done", text: "最终回答", reason: "completed" });
      await started;
      expect(loadSessionState(autoWorkspace, "auto-memory-background").autoMemory.pendingTurns).toHaveLength(1);

      const logPath = resolve(autoWorkspace, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
      expect(readFileSync(logPath, "utf-8")).toContain("[AUTO_MEMORY] 后台整理已排队");
      expect(readFileSync(logPath, "utf-8")).toContain("[AUTO_MEMORY] 开始整理 trigger=threshold");

      releaseAnalysis();
      await vi.waitFor(() => {
        expect(loadSessionState(autoWorkspace, "auto-memory-background").autoMemory.pendingTurns).toHaveLength(0);
        expect(readFileSync(logPath, "utf-8")).toContain("[AUTO_MEMORY] 整理完成 trigger=threshold");
      });
    } finally {
      releaseAnalysis?.();
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("persists auto-memory pending turns across plugin manager restarts", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 2 },
      sessionSummary: { enabled: false },
    });
    const firstManager = new PluginManager(autoWorkspace);
    const secondManager = new PluginManager(autoWorkspace);
    try {
      await firstManager.loadCorePlugins();
      const firstClient = new AutoMemoryModelClient([
        { text: "第一轮最终回答", toolCalls: [] },
      ]);
      const firstSession = new AgentSession("auto-memory-persistent", autoWorkspace, firstManager, {}, firstClient);

      await collect(firstSession.chat("第一轮用户问题"));

      expect(loadSessionState(autoWorkspace, "auto-memory-persistent").autoMemory).toMatchObject({
        turnsSinceAnalysis: 1,
        pendingTurns: [{ user: "第一轮用户问题", assistant: "第一轮最终回答" }],
      });

      await firstManager.destroy();

      await secondManager.loadCorePlugins();
      const secondClient = new AutoMemoryModelClient([
        { text: "第二轮最终回答", toolCalls: [] },
        { text: "无需更新长期记忆。", toolCalls: [] },
      ]);
      const secondSession = new AgentSession("auto-memory-persistent", autoWorkspace, secondManager, {}, secondClient);

      await collect(secondSession.chat("第二轮用户问题"));

      const prompt = String(secondClient.calls[1][0].content);
      expect(prompt).toContain("[user] 第一轮用户问题");
      expect(prompt).toContain("[assistant] 第一轮最终回答");
      expect(prompt).toContain("[user] 第二轮用户问题");
      expect(prompt).toContain("[assistant] 第二轮最终回答");
      expect(loadSessionState(autoWorkspace, "auto-memory-persistent").autoMemory).toMatchObject({
        turnsSinceAnalysis: 0,
        pendingTurns: [],
        lastResult: { analyzedTurns: 2 },
      });
    } finally {
      await firstManager.destroy();
      await secondManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("triggers auto-memory from pending turns across all workspace sessions", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 3 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
    await appendSessionMessage(autoWorkspace, "session-a", { role: "user", content: "会话 A", _timestamp: 1 });
    await appendSessionMessage(autoWorkspace, "session-b", { role: "user", content: "会话 B", _timestamp: 2 });
      saveSessionState(autoWorkspace, {
        sessionId: "session-a",
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{
            user: "会话 A 的长期偏好",
            assistant: "最终回答 A",
            at: new Date(1).toISOString(),
          }],
          turnsSinceAnalysis: 1,
        },
      });
      saveSessionState(autoWorkspace, {
        sessionId: "session-b",
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{
            user: "会话 B 的项目规则",
            assistant: "最终回答 B",
            at: new Date(2).toISOString(),
          }],
          turnsSinceAnalysis: 1,
        },
      });

      const client = new AutoMemoryModelClient([
        { text: "会话 C 最终回答", toolCalls: [] },
        { text: "已整理整个工作区的长期记忆。", toolCalls: [] },
      ]);
      const session = new AgentSession("session-c", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("会话 C 的新增信息"));

      const prompt = String(client.calls[1][0].content);
      expect(prompt).toContain("### Session session-a");
      expect(prompt).toContain("[user] 会话 A 的长期偏好");
      expect(prompt).toContain("### Session session-b");
      expect(prompt).toContain("[user] 会话 B 的项目规则");
      expect(prompt).toContain("### Session session-c");
      expect(prompt).toContain("[user] 会话 C 的新增信息");
      expect(loadSessionState(autoWorkspace, "session-a").autoMemory.pendingTurns).toHaveLength(0);
      expect(loadSessionState(autoWorkspace, "session-b").autoMemory.pendingTurns).toHaveLength(0);
      expect(loadSessionState(autoWorkspace, "session-c").autoMemory.pendingTurns).toHaveLength(0);
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("keeps persisted auto-memory pending turns when analysis fails", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 1 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      const client = new AutoMemoryModelClient([
        { text: "最终回答", toolCalls: [] },
      ]);
      const session = new AgentSession("auto-memory-failure", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("用户问题"));

      expect(loadSessionState(autoWorkspace, "auto-memory-failure").autoMemory).toMatchObject({
        turnsSinceAnalysis: 1,
        pendingTurns: [{ user: "用户问题", assistant: "最终回答" }],
      });
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("keeps turns added during analysis and skips a concurrent workspace analysis", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "suggest", turnThreshold: 1, lockTimeoutSeconds: 60 },
      sessionSummary: { enabled: false },
    });
    let releaseModel!: () => void;
    let modelStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      modelStarted = resolveStarted;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseModel = resolveRelease;
    });
    const client: ModelClient = {
      complete: async () => "",
      chat: async () => {
        modelStarted();
        await release;
        return { text: "无需更新", toolCalls: [] };
      },
    };
    const memoryListTool: Tool = {
      name: "memory_list",
      description: "list",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "暂无记忆",
    };
    const definitions = [{
      name: "memory_list",
      description: "list",
      input_schema: { type: "object" as const, properties: {} },
    }];

    try {
      saveSessionState(autoWorkspace, {
        sessionId: "session-a",
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{
            id: "turn-before-analysis",
            user: "旧问题",
            assistant: "旧回答",
            at: "2026-07-31T00:00:00.000Z",
          }],
          turnsSinceAnalysis: 1,
        },
      });

      const first = runWorkspaceAutoMemoryAnalysis({
        workspacePath: autoWorkspace,
        config: loadConfig(autoWorkspace),
        client,
        triggerSessionId: "session-a",
        getToolDefinitions: () => definitions,
        getTool: (name) => name === "memory_list" ? memoryListTool : undefined,
      });
      await started;

      updateSessionState(autoWorkspace, "session-a", (latest) => ({
        sessionId: latest.sessionId,
        summary: latest.summary,
        pendingMessages: latest.pendingMessages,
        turnsSinceSummary: latest.turnsSinceSummary,
        autoMemory: {
          ...latest.autoMemory,
          pendingTurns: [...latest.autoMemory.pendingTurns, {
            id: "turn-during-analysis",
            user: "新问题",
            assistant: "新回答",
            at: "2026-07-31T00:01:00.000Z",
          }],
          turnsSinceAnalysis: latest.autoMemory.pendingTurns.length + 1,
        },
      }));

      const concurrent = await runWorkspaceAutoMemoryAnalysis({
        workspacePath: autoWorkspace,
        config: loadConfig(autoWorkspace),
        client,
        triggerSessionId: "session-a",
        getToolDefinitions: () => definitions,
        getTool: (name) => name === "memory_list" ? memoryListTool : undefined,
      });
      expect(concurrent.finalText).toContain("已有记忆整理任务正在运行");

      releaseModel();
      await first;

      expect(loadSessionState(autoWorkspace, "session-a").autoMemory.pendingTurns).toEqual([
        expect.objectContaining({ id: "turn-during-analysis", user: "新问题" }),
      ]);
    } finally {
      releaseModel?.();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("reclaims a recent auto-memory lock left by a stopped gateway", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "hybrid", turnThreshold: 1, lockTimeoutSeconds: 300 },
      sessionSummary: { enabled: false },
    });
    const lockPath = resolve(autoWorkspace, ".locks", "auto-memory.lock");

    try {
      saveSessionState(autoWorkspace, {
        sessionId: "session-a",
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{
            id: "turn-before-restart",
            user: "重启前的问题",
            assistant: "重启前的回答",
            at: "2026-08-04T00:00:00.000Z",
          }],
          turnsSinceAnalysis: 1,
        },
      });
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(resolve(lockPath, "owner.json"), JSON.stringify({
        runId: "stopped-gateway",
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
      }));

      const result = await runWorkspaceAutoMemoryAnalysis({
        workspacePath: autoWorkspace,
        config: loadConfig(autoWorkspace),
        client: new FakeModelClient([]),
        triggerSessionId: "session-a",
        getToolDefinitions: () => [],
        getTool: () => undefined,
      });

      expect(result.finalText).not.toContain("已有记忆整理任务正在运行");
      expect(result.analyzedTurns).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("auto-memory rejects oversized memory content instead of truncating it", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "hybrid", turnThreshold: 1 },
      memory: { maxItemChars: 1000, maxTotalChars: 5000 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      const longSaved = "A".repeat(1500);
      const client = new AutoMemoryModelClient([
        { text: "我会整理这些记忆", toolCalls: [] },
        {
          text: "",
          toolCalls: [{
            type: "tool_use",
            id: "save-long",
            name: "memory_save",
            input: {
              name: "long-saved",
              summary: "长记忆",
              content: longSaved,
              tags: ["test"],
              scope: "project",
            },
          }],
        },
        { text: "已保存长记忆。", toolCalls: [] },
      ]);
      const session = new AgentSession("auto-memory-clamp", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("请整理长记忆"));

      expect(getMemoryRecord(autoWorkspace, "long-saved")).toBeNull();
      expect(JSON.stringify(client.calls[2].at(-1)?.content)).toContain("memory_content_too_large");
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("auto-memory includes existing memories and can rewrite them with compressed content", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 1, maxBatchChars: 8000 },
      memory: { maxItemChars: 1000, maxTotalChars: 5000 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      saveMemory(autoWorkspace, "project-rule", [
        "旧项目规则：",
        "- README 要保持简洁。",
        "- README 要保持简洁。",
        "- 已废弃：每次回答都必须输出超长解释。",
      ].join("\n"), { summary: "项目规则", source: "manual" });

      const client = new AutoMemoryModelClient([
        { text: "我会整理项目规则", toolCalls: [] },
        {
          text: "",
          toolCalls: [{
            type: "tool_use",
            id: "compress-rule",
            name: "memory_save",
            input: {
              name: "project-rule",
              summary: "项目规则",
              content: "项目规则：README 要保持简洁。",
              tags: ["project"],
              scope: "project",
            },
          }],
        },
        { text: "已压缩整理 project-rule。", toolCalls: [] },
      ]);
      const session = new AgentSession("auto-memory-compress-existing", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("刚才的 README 规则可以整理一下"));

      const prompt = String(client.calls[1][0].content);
      expect(prompt).toContain("project-rule: 项目规则");
      expect(prompt).not.toContain("旧项目规则");
      expect(prompt).not.toContain("README 要保持简洁");
      expect(prompt).toContain("本次需要整理的增量对话");
      expect(getMemoryRecord(autoWorkspace, "project-rule")).toMatchObject({
        content: "项目规则：README 要保持简洁。",
        source: "auto",
      });
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("auto-memory saves and updates memory through tool calls", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 1 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      saveMemory(autoWorkspace, "project-rule", "旧规则", { summary: "旧规则", source: "manual" });
      const client = new AutoMemoryModelClient([
        { text: "我会记住这些规则", toolCalls: [] },
        {
          text: "",
          toolCalls: [
            {
              type: "tool_use",
              id: "save-new",
              name: "memory_save",
              input: {
                name: "user-preference",
                summary: "用户偏好",
                content: "用户偏好直接、简洁的回答。",
                tags: ["preference"],
                scope: "user",
              },
            },
            {
              type: "tool_use",
              id: "save-existing",
              name: "memory_save",
              input: {
                name: "project-rule",
                summary: "项目规则",
                content: "项目规则：README 必须保持简洁。",
                tags: ["project"],
                scope: "project",
              },
            },
          ],
        },
        { text: "已保存并更新长期记忆。", toolCalls: [] },
      ]);
      const session = new AgentSession("auto-memory-save-update", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("请记住我的偏好，并更新项目规则"));

      expect(getMemoryRecord(autoWorkspace, "user-preference")).toMatchObject({
        content: "用户偏好直接、简洁的回答。",
        summary: "用户偏好",
        source: "auto",
      });
      expect(getMemoryRecord(autoWorkspace, "project-rule")).toMatchObject({
        content: "项目规则：README 必须保持简洁。",
        summary: "项目规则",
        source: "auto",
      });
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("auto-memory deletes stale memories only when memory_delete is allowed", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 1, maxCandidates: 1 },
      sessionSummary: { enabled: false },
      security: { mode: "auto", tools: { memory_delete: { mode: "allow" } } },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      saveMemory(autoWorkspace, "old-rule", "旧规则", { source: "manual" });
      saveMemory(autoWorkspace, "other-rule", "另一个旧规则", { source: "manual" });
      const client = new AutoMemoryModelClient([
        { text: "旧规则已经废弃", toolCalls: [] },
        {
          text: "",
          toolCalls: [
            { type: "tool_use", id: "delete-old", name: "memory_delete", input: { name: "old-rule" } },
            { type: "tool_use", id: "delete-other", name: "memory_delete", input: { name: "other-rule" } },
          ],
        },
      ]);
      const session = new AgentSession("auto-memory-delete", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("旧规则已经废弃"));

      expect(getMemoryRecord(autoWorkspace, "old-rule")).toBeNull();
      expect(getMemoryRecord(autoWorkspace, "other-rule")).not.toBeNull();
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
  });

  it("does not expose memory_delete in hybrid mode", async () => {
    const autoWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "hybrid", turnThreshold: 1 },
      sessionSummary: { enabled: false },
    });
    const autoManager = new PluginManager(autoWorkspace);
    try {
      await autoManager.loadCorePlugins();
      saveMemory(autoWorkspace, "old-rule", "旧规则", { source: "manual" });
      const client = new AutoMemoryModelClient([
        { text: "旧规则可能已经废弃", toolCalls: [] },
        { text: "建议人工确认是否删除 old-rule。", toolCalls: [] },
      ]);
      const session = new AgentSession("auto-memory-hybrid-delete", autoWorkspace, autoManager, {}, client);

      await collect(session.chat("旧规则可能已经废弃"));

      expect(getMemoryRecord(autoWorkspace, "old-rule")).not.toBeNull();
      expect(client.toolDefinitions[1]?.map((tool) => tool.name).sort()).toEqual([
        "memory_list",
        "memory_read",
        "memory_save",
        "memory_search",
        "profile_list",
        "profile_read",
        "profile_save",
      ]);
    } finally {
      await autoManager.destroy();
      removeTempWorkspace(autoWorkspace);
    }
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
      toolCallId: "missing",
      completedAt: expect.any(Number),
      name: "missing",
      result: expect.stringContaining('"status":"blocked"'),
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolCallId: "fail",
      completedAt: expect.any(Number),
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
      { type: "tool_call", toolCallId: "call-1", name: "gated", input: {}, startedAt: expect.any(Number) },
      {
        type: "tool_result",
        toolCallId: "call-1",
        name: "gated",
        completedAt: expect.any(Number),
        result: JSON.stringify({ error: "需要批准", requiresConfirmation: true, approvalId: "approval-1" }),
      },
      { type: "done", text: "先申请授权", reason: "approval_required" },
    ]);
    expect(client.calls).toHaveLength(1);
    expect(gatedTool).toHaveBeenCalledTimes(1);
    expect(laterTool).not.toHaveBeenCalled();
  });

  it("persists reasoning across approval and ends a failed resumed run", async () => {
    const config = loadConfig(workspacePath);
    config.sessionSummary.enabled = true;
    writeFileSync(resolve(workspacePath, "config.json"), JSON.stringify(config), "utf-8");
    let calls = 0;
    saveSessionState(workspacePath, { sessionId: "reason-resume", summary: "审批续跑摘要", pendingMessages: [], turnsSinceSummary: 0 });
    registerTool(manager, { name: "reason-gate", description: "gate", inputSchema: { type: "object" },
      execute: async () => ++calls === 1 ? JSON.stringify({ requiresConfirmation: true, approvalId: "reason-approval" }) : "ok" });
    const client = new FakeModelClient([
      { text: "", reasoningContent: "protocol metadata", toolCalls: [{ type: "tool_use", id: "r-call", name: "reason-gate", input: {} }] },
      (messages, _tools, systemPrompt) => {
        expect(messages.find(m => m.role === "assistant")?._reasoningContent).toBe("protocol metadata");
        expect(systemPrompt).toContain("审批续跑摘要");
        expect(JSON.stringify(messages)).not.toContain("session_memory_summary");
        throw new Error("model 400");
      },
    ]);
    const session = new AgentSession("reason-resume", workspacePath, manager, {}, client);
    await collect(session.chat("run"));
    const turn = manager.getTurnId(session.id)!;
    const events = await collect(session.resumeApproval("reason-approval"));
    expect(events.at(-1)).toMatchObject({ type: "error", message: "model 400" });
    expect(readRun(workspacePath, session.id, turn)?.state).toBe("interrupted");
    expect(session.isBusy()).toBe(false);
    expect(calls).toBe(2); // One approval check, then one actual execution; no replay after the API error.
    expect(JSON.stringify(readSessionMessages(workspacePath, session.id))).toContain('"content":"ok"');
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
    const suspendedTurnId = manager.getTurnId("approval-resume");
    expect(suspendedTurnId).toBeDefined();
    expect(await collect(session.chat("new task before approval"))).toEqual([
      { type: "error", message: "当前会话有待审批的工具调用。请先批准或拒绝最新审批，再继续发送新任务。" },
    ]);
    expect(await collect(session.resumeApproval("approval-1"))).toEqual([
      { type: "tool_call", toolCallId: "call-1", name: "gated", input: {}, startedAt: expect.any(Number) },
      { type: "tool_result", toolCallId: "call-1", name: "gated", result: "approved-result", completedAt: expect.any(Number) },
      { type: "text_delta", text: "继续后的总结" },
      { type: "done", text: "继续后的总结", reason: "completed" },
    ]);
    expect(client.calls).toHaveLength(2);
    expect(gatedTool).toHaveBeenCalledTimes(2);
    expect(laterTool).not.toHaveBeenCalled();
    expect(manager.getTurnId("approval-resume")).toBeUndefined();
  });

  it("feeds a rejected approval back into the original model loop", async () => {
    const gatedTool = vi.fn(async () => JSON.stringify({
      error: "需要批准", requiresConfirmation: true, approvalId: "reject-approval",
    }));
    registerTool(manager, { name: "gated_reject", description: "gated", inputSchema: { type: "object" }, execute: gatedTool });
    const client = new FakeModelClient([
      { text: "等待决定", toolCalls: [{ type: "tool_use", id: "reject-call", name: "gated_reject", input: {} }] },
      (messages) => {
        expect(JSON.stringify(messages)).toContain("用户拒绝执行该工具调用");
        return { text: "已按拒绝结果调整", toolCalls: [] };
      },
    ]);
    const session = new AgentSession("approval-reject", workspacePath, manager, {}, client);
    await collect(session.chat("run"));
    const events = await collect(session.rejectApproval("reject-approval"));
    expect(events).toContainEqual({
      type: "tool_result",
      toolCallId: "reject-call",
      name: "gated_reject",
      result: JSON.stringify({ error: "用户拒绝执行该工具调用", rejected: true }),
    });
    expect(events.at(-1)).toEqual({ type: "done", text: "已按拒绝结果调整", reason: "completed" });
    expect(gatedTool).toHaveBeenCalledTimes(1);
  });

  it.each(["approve", "reject"])("restores completed sibling results before %s in a new AgentSession", async action => {
    const config = loadConfig(workspacePath);
    config.sessionSummary.enabled = true;
    config.security = { ...config.security, mode: "ask" };
    writeFileSync(resolve(workspacePath, "config.json"), JSON.stringify(config), "utf-8");
    const execute = vi.fn(async (args: Record<string, unknown>, context?: Parameters<Tool["execute"]>[1]) => {
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: loadConfig(workspacePath),
        toolName: "durable_tool",
        args,
        context,
      });
      return permission.allowed ? "restored-result" : permission.result;
    });
    registerTool(manager, { name: "durable_tool", description: "durable", inputSchema: { type: "object" }, execute });
    const completed = vi.fn(async () => "already-completed-result");
    registerTool(manager, { name: "completed_tool", description: "read", inputSchema: { type: "object" }, execute: completed });
    const firstClient = new FakeModelClient([{
      text: "等待审批",
      reasoningContent: "durable protocol metadata",
      toolCalls: [
        { type: "tool_use", id: "completed-call", name: "completed_tool", input: {} },
        { type: "tool_use", id: "durable-call", name: "durable_tool", input: { value: 1 } },
      ],
    }]);
    const firstSession = new AgentSession("durable-approval", workspacePath, manager, {}, firstClient);
    saveSessionState(workspacePath, { sessionId: firstSession.id, summary: "重启恢复摘要", pendingMessages: [], turnsSinceSummary: 0 });
    expect((await collect(firstSession.chat("run"))).at(-1)).toEqual({ type: "done", text: "等待审批", reason: "approval_required" });
    const approval = listApprovals(workspacePath)[0];
    expect(listSessionApprovalContinuations(workspacePath, firstSession.id)).toHaveLength(1);
    expect(existsSync(resolve(workspacePath, "approvals", `${approval.id}.json`))).toBe(true);

    const restoredManager = new PluginManager(workspacePath);
    await restoredManager.loadCorePlugins();
    registerTool(restoredManager, { name: "durable_tool", description: "durable", inputSchema: { type: "object" }, execute });
    const restoredClient = new FakeModelClient([(messages, _tools, systemPrompt) => {
      expect(systemPrompt).toContain("重启恢复摘要");
      expect(JSON.stringify(messages)).not.toContain("session_memory_summary");
      expect(messages.find(message => Array.isArray(message.content)
        && message.content.some(block => block.type === "tool_use" && block.id === "durable-call"))?._reasoningContent)
        .toBe("durable protocol metadata");
      expect(JSON.stringify(messages)).toContain('"tool_use_id":"durable-call"');
      expect(JSON.stringify(messages)).toContain(action === "approve" ? "restored-result" : "用户拒绝执行");
      expect(JSON.stringify(messages)).toContain("already-completed-result");
      expect(messages.filter(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result" && block.tool_use_id === "completed-call"))).toHaveLength(1);
      return { text: "恢复完成", toolCalls: [] };
    }]);
    if (action === "approve") expect(approveRequest(workspacePath, approval.id)?.status).toBe("approved");
    const restoredSession = new AgentSession("durable-approval", workspacePath, restoredManager, {}, restoredClient);
    expect((await collect(action === "approve" ? restoredSession.resumeApproval(approval.id) : restoredSession.rejectApproval(approval.id))).at(-1)).toEqual({
      type: "done", text: "恢复完成", reason: "completed",
    });
    expect(execute).toHaveBeenCalledTimes(action === "approve" ? 2 : 1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(listSessionApprovalContinuations(workspacePath, firstSession.id)).toEqual([]);
    await restoredManager.destroy();
  });

  it("allows all ask-mode tools for the resumed turn and clears the grant afterwards", async () => {
    const config = loadConfig(workspacePath);
    config.security = { ...config.security, mode: "ask" };
    writeFileSync(resolve(workspacePath, "config.json"), JSON.stringify(config), "utf-8");
    const dangerousTool = vi.fn(async (args: Record<string, unknown>, context?: Parameters<Tool["execute"]>[1]) => {
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: loadConfig(workspacePath),
        toolName: "dangerous",
        args,
        context,
      });
      return permission.allowed ? `ran-${String(args.command)}` : permission.result;
    });
    registerTool(manager, {
      name: "dangerous",
      description: "dangerous",
      inputSchema: { type: "object", properties: {} },
      execute: dangerousTool,
    });
    const client = new FakeModelClient([
      {
        text: "申请第一项权限",
        toolCalls: [{ type: "tool_use", id: "call-1", name: "dangerous", input: { command: "first" } }],
      },
      {
        text: "继续执行第二项",
        toolCalls: [{ type: "tool_use", id: "call-2", name: "dangerous", input: { command: "second" } }],
      },
      { text: "本轮完成", toolCalls: [] },
    ]);
    const session = new AgentSession("approval-turn", workspacePath, manager, {}, client);

    await collect(session.chat("run"));
    const approval = listApprovals(workspacePath)[0];
    expect(approveTurnRequest(workspacePath, approval.id)?.status).toBe("approved");
    expect(hasTurnApproval(workspacePath, session.id)).toBe(true);

    const resumed = await collect(session.resumeApproval(approval.id));

    expect(resumed).toContainEqual({ type: "tool_result", toolCallId: "call-1", name: "dangerous", result: "ran-first", completedAt: expect.any(Number) });
    expect(resumed).toContainEqual({ type: "tool_result", toolCallId: "call-2", name: "dangerous", result: "ran-second", completedAt: expect.any(Number) });
    expect(dangerousTool).toHaveBeenCalledTimes(3);
    expect(hasTurnApproval(workspacePath, session.id)).toBe(false);
  });

  it("preserves complete persisted tool chains and repairs only orphaned calls on restore", async () => {
    await appendSessionMessage(workspacePath, "restore", { role: "user", content: "legacy request" });
    await appendSessionMessage(workspacePath, "restore", {
      role: "assistant",
      content: [
        { type: "text", text: "legacy text" },
        { type: "tool_use", id: "missing-result", name: "echo", input: {} },
      ],
    });
    await appendSessionMessage(workspacePath, "restore", {
      role: "assistant",
      content: [{ type: "tool_use", id: "complete-result", name: "echo", input: {} }],
    });
    await appendSessionMessage(workspacePath, "restore", {
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
          expect.objectContaining({ role: "assistant", content: [{ type: "tool_use", id: "complete-result", name: "echo", input: {} }] }),
          expect.objectContaining({ role: "user", content: [{ type: "tool_result", tool_use_id: "complete-result", content: "ok" }] }),
          expect.objectContaining({ role: "user", content: "continue" }),
        ]);
        return { text: "done", toolCalls: [] };
      },
    ]);
    const session = new AgentSession("restore", workspacePath, manager, {}, client);

    expect(await collect(session.chat("continue"))).toEqual([
      { type: "text_delta", text: "done" },
      { type: "done", text: "done", reason: "completed" },
    ]);
  });

  it.each([false, true])("keeps the run busy until synchronous compression settles (failure=%s)", async (fails) => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, contextCompressionThreshold: 0.1, contextCompressionTargetRatio: 0.05, sessionSummary: { maxBudgetRatio: 0.025, enabled: true, persistent: true, turnThreshold: 1, recentTurns: 1 } });
    const pm = new PluginManager(workspace);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let running: Promise<void> | undefined;
    try {
      await pm.loadCorePlugins();
      await appendSessionMessage(workspace, "slow-summary", { role: "user", content: "历史内容".repeat(7000) });
      const client = new SummaryModelClient([{ text: "您要继续吗？", toolCalls: [] }]);
      const complete = client.complete.bind(client);
      vi.spyOn(client, "complete").mockImplementation(async (messages) => {
        await waiting;
        if (fails) throw new Error("compression unavailable");
        return complete(messages);
      });
      const session = new AgentSession("slow-summary", workspace, pm, {}, client);
      const events: AgentEvent[] = [];
      running = (async () => { for await (const event of session.chat("解释结果", undefined, undefined, "plan", "slow-turn")) events.push(event); })();
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "status", stage: "session_summary", state: "started", message: "正在进行上下文压缩..." })));
      expect(session.isBusy()).toBe(true);
      expect(readRun(workspace, session.id, "slow-turn")).toMatchObject({ state: "running", status: { stage: "session_summary", state: "started" } });
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(events.some((event) => event.type === "run_state" && event.run.state === "completed")).toBe(false);
      expect(await collect(session.chat("继续"))).toEqual([{ type: "error", message: "会话正在执行中，请等待完成或先取消当前任务" }]);
      release();
      await running;
      expect(session.isBusy()).toBe(false);
      expect(readRun(workspace, session.id, "slow-turn")?.state).toBe("completed");
      expect(events).toContainEqual(expect.objectContaining({ type: "status", stage: "session_summary", state: fails ? "failed" : "completed" }));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      if (fails) {
        expect(loadSessionSummary(workspace, session.id).summarizedThroughSequence).toBe(0);
        expect(client.calls[0]).toContainEqual(expect.objectContaining({ content: "历史内容".repeat(7000) }));
      }
      expect(session.getMessages()).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "解释结果" })]));
    } finally {
      release();
      await running;
      await pm.destroy();
      removeTempWorkspace(workspace);
    }
  });

  it("cancels synchronous summary without committing it and unlocks the session", async () => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, contextCompressionThreshold: 0.1, contextCompressionTargetRatio: 0.05, sessionSummary: { maxBudgetRatio: 0.025, enabled: true, persistent: true, turnThreshold: 1, recentTurns: 1 } });
    const pm = new PluginManager(workspace);
    let pending: Promise<AgentEvent[]> | undefined;
    let session: AgentSession | undefined;
    try {
      await pm.loadCorePlugins();
      await appendSessionMessage(workspace, "cancel-summary", { role: "user", content: "历史内容".repeat(7000) });
      const client = new SummaryModelClient([{ text: "done", toolCalls: [] }, { text: "next", toolCalls: [] }]);
      let started = false;
      vi.spyOn(client, "complete").mockImplementationOnce((_messages, _prompt, options) => new Promise((_resolve, reject) => {
        started = true;
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }));
      session = new AgentSession("cancel-summary", workspace, pm, {}, client);
      pending = collectAll(session.chat("hello", undefined, undefined, "normal", "summary-turn"));
      await vi.waitFor(() => expect(started).toBe(true));
      session.cancel();
      await pending;
      expect(session.isBusy()).toBe(false);
      expect(readRun(workspace, session.id, "summary-turn")?.state).toBe("cancelled");
      expect(loadSessionSummary(workspace, session.id).summarizedThroughSequence).toBe(0);
      expect((await collect(session.chat("next"))).at(-1)).toMatchObject({ type: "done" });
    } finally {
      session?.cancel();
      await pending;
      await pm.destroy();
      removeTempWorkspace(workspace);
    }
  });

  it("persists session summaries and restores them after rebuilding the session", async () => {
    const summaryWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      contextCompressionThreshold: 0.1,
      contextCompressionTargetRatio: 0.05,
      sessionSummary: { maxBudgetRatio: 0.025, enabled: true, persistent: true, turnThreshold: 1, recentTurns: 1 },
    });
    const firstManager = new PluginManager(summaryWorkspace);
    const secondManager = new PluginManager(summaryWorkspace);
    try {
      await firstManager.loadCorePlugins();
      await appendSessionMessage(summaryWorkspace, "summary-session", { role: "user", content: "旧内容".repeat(10000) });
      const firstClient = new SummaryModelClient([{ text: "第一轮完成", toolCalls: [] }]);
      const firstSession = new AgentSession("summary-session", summaryWorkspace, firstManager, {}, firstClient);

      expect(await collect(firstSession.chat("记住这个目标"))).toEqual([
        { type: "status", stage: "session_summary", state: "started", message: "正在进行上下文压缩...", beforeTokens: expect.any(Number) },
        { type: "status", stage: "session_summary", state: "started", message: expect.stringContaining("正在压缩第 1/3 批"), beforeTokens: expect.any(Number) },
        { type: "status", stage: "session_summary", state: "completed", message: "上下文压缩达标", beforeTokens: expect.any(Number), afterTokens: expect.any(Number) },
        { type: "text_delta", text: "第一轮完成" },
        { type: "done", text: "第一轮完成", reason: "completed" },
      ]);
      const persistedSummary = loadSessionSummary(summaryWorkspace, "summary-session");
      expect(persistedSummary.checkpoint.categories.goals[0].text).toContain("持久化摘要");
      expect(persistedSummary.checkpoint.categories.goals[0].source.messageIds).toHaveLength(1);

      await secondManager.loadCorePlugins();
      const secondClient = new SummaryModelClient([{ text: "第二轮完成", toolCalls: [] }]);
      const secondSession = new AgentSession("summary-session", summaryWorkspace, secondManager, { contextCompressionThreshold: 0.7 }, secondClient);

      expect(await collect(secondSession.chat("继续"))).toEqual([
        { type: "text_delta", text: "第二轮完成" },
        { type: "done", text: "第二轮完成", reason: "completed" },
      ]);
      expect(secondClient.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "记住这个目标" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "第一轮完成" }],
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
      expect(secondClient.calls[0]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("[当前会话摘要]") }),
      ]));
      expect(JSON.stringify(secondClient.calls[0])).not.toContain("session_memory_summary");
      expect(secondClient.systemPrompts[0]).toContain("以历史原文为准");
      expect(secondClient.systemPrompts[0]).toBe(firstClient.systemPrompts[0]);
      const snapshot = JSON.parse(readFileSync(resolve(sessionDir(summaryWorkspace, "summary-session"), "context-snapshot.json"), "utf8"));
      expect(snapshot.contextSummaries).toEqual([
        { title: "会话摘要", content: expect.stringContaining("session_memory_summary") },
      ]);
      expect(snapshot.systemPrompt).toContain(snapshot.contextSummaries[0].content);
      expect(JSON.stringify(snapshot.messages)).not.toContain("session_memory_summary");
    } finally {
      await firstManager.destroy();
      await secondManager.destroy();
      removeTempWorkspace(summaryWorkspace);
    }
  });

  it("does not summarize low-token conversations by round count or lose history to the window", async () => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, historyWindowSize: 1, sessionSummary: { enabled: true, turnThreshold: 1 } });
    const pm = new PluginManager(workspace);
    try {
      await pm.loadCorePlugins();
      const client = new SummaryModelClient(Array.from({ length: 12 }, () => ({ text: "ok", toolCalls: [] })));
      const session = new AgentSession("small-rounds", workspace, pm, {}, client);
      for (let i = 0; i < 12; i++) {
        const events = await collect(session.chat(`question ${i}`));
        expect(events.some((event) => event.type === "status")).toBe(false);
      }
      expect(client.completeCalls).toHaveLength(0);
      expect(client.calls.at(-1)).toContainEqual(expect.objectContaining({ content: "question 0" }));
      expect(loadSessionSummary(workspace, session.id).revision).toBe(0);
    } finally {
      await pm.destroy();
      removeTempWorkspace(workspace);
    }
  });

  it("only extracts uncovered history after restarting a compressed session", async () => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, contextCompressionThreshold: 0.1, contextCompressionTargetRatio: 0.05, sessionSummary: { maxBudgetRatio: 0.025, enabled: true, recentTurns: 0 } });
    const first = new PluginManager(workspace);
    const second = new PluginManager(workspace);
    try {
      await first.loadCorePlugins();
      const original = await appendSessionMessage(workspace, "incremental", { role: "user", content: "第一批".repeat(10000) });
      const firstClient = new SummaryModelClient([{ text: "ok", toolCalls: [] }]);
      const session = new AgentSession("incremental", workspace, first, {}, firstClient);
      expect((await collect(session.chat("继续"))).at(-1)).toMatchObject({ type: "done" });
      const saved = loadSessionSummary(workspace, session.id);
      expect(saved.summarizedThroughSequence).toBe(original._sequence);
      await appendSessionMessage(workspace, session.id, { role: "user", content: "第二批".repeat(10000) });
      await second.loadCorePlugins();
      const client = new SummaryModelClient([{ text: "ok", toolCalls: [] }]);
      const restored = new AgentSession(session.id, workspace, second, {}, client);
      expect((await collect(restored.chat("再继续"))).at(-1)).toMatchObject({ type: "done" });
      const request = JSON.parse(client.completeCalls[0][0].content as string);
      expect(request.batch.fromSequence).toBe(saved.summarizedThroughSequence + 1);
      expect(request.messages.every((message: { sequence: number }) => message.sequence > saved.summarizedThroughSequence)).toBe(true);
      expect(readSessionMessages(workspace, session.id)).toContainEqual(expect.objectContaining({ _messageId: original._messageId, content: original.content }));
    } finally {
      await first.destroy();
      await second.destroy();
      removeTempWorkspace(workspace);
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
        { type: "done", text: "第一轮完成", reason: "completed" },
      ]);

      const cachedState = loadSessionState(summaryRefreshWorkspace, "summary-refresh-session");
      writeFileSync(
        sessionStateFilePath(summaryRefreshWorkspace, "summary-refresh-session"),
        `${JSON.stringify({
          ...cachedState,
          summary: "外部写入的会话摘要",
          pendingMessages: [],
          turnsSinceSummary: 0,
          updatedAt: cachedState.updatedAt,
        }, null, 2)}\n`,
        "utf-8",
      );

      expect(await collect(session.chat("继续"))).toEqual([
        { type: "text_delta", text: "第二轮完成" },
        { type: "done", text: "第二轮完成", reason: "completed" },
      ]);

      expect(client.calls[1]).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "继续" })]));
      expect(JSON.stringify(client.calls[1])).not.toContain("session_memory_summary");
      expect(client.systemPrompts[1]).toContain("外部写入的会话摘要");
      expect(client.systemPrompts[1]).toContain('"type":"legacy_summary"');
      expect(client.systemPrompts[0]).not.toContain("外部写入的会话摘要");
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
    await appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", { role: "user", content: "最近问题 A", _timestamp: 10 });
    await appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", {
        role: "assistant",
        content: [{ type: "text", text: "最近回答 A" }],
        _timestamp: 11,
      });
    await appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", { role: "user", content: "最近问题 B", _timestamp: 12 });
    await appendSessionMessage(summaryRecentWorkspace, "summary-recent-session", {
        role: "assistant",
        content: [{ type: "text", text: "最近回答 B" }],
        _timestamp: 13,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-recent-session", summaryRecentWorkspace, summaryRecentManager, {}, client);

      expect(await collect(session.chat("当前问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
      ]);

      expect(client.calls[0]).toEqual([
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
      expect(client.systemPrompts[0]).toContain("已有会话摘要");
      expect(client.systemPrompts[0]).toContain("迁移自旧版自由文本摘要");
    } finally {
      await summaryRecentManager.destroy();
      removeTempWorkspace(summaryRecentWorkspace);
    }
  });

  it("keeps all uncovered turns including tools when migrating an unbounded legacy summary", async () => {
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
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", { role: "user", content: "历史问题 1", _timestamp: 1 });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [{ type: "text", text: "历史回答 1" }],
        _timestamp: 2,
      });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", { role: "user", content: "历史问题 2", _timestamp: 3 });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [
          { type: "text", text: "我来查一下历史问题 2" },
          { type: "tool_use", id: "tool-2", name: "web_search", input: { query: "历史问题 2" } },
        ],
        _timestamp: 4,
      });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "工具结果 2".repeat(1000) }],
        _timestamp: 5,
      });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [{ type: "text", text: "历史回答 2" }],
        _timestamp: 6,
      });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", { role: "user", content: "历史问题 3", _timestamp: 7 });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-3", name: "web_search", input: { query: "历史问题 3" } },
        ],
        _timestamp: 8,
      });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-3", content: "工具结果 3".repeat(1000) }],
        _timestamp: 9,
      });
    await appendSessionMessage(summaryTurnsWorkspace, "summary-turns-session", {
        role: "assistant",
        content: [{ type: "text", text: "历史回答 3" }],
        _timestamp: 10,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-turns-session", summaryTurnsWorkspace, summaryTurnsManager, {}, client);

      expect(await collect(session.chat("当前问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
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
          content: [{ type: "text", text: "我来查一下历史问题 2" }, { type: "tool_use", id: "tool-2", name: "web_search", input: { query: "历史问题 2" } }],
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
      expect(client.calls[0]).toEqual(expect.arrayContaining([
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
    await appendSessionMessage(summaryToolWorkspace, "summary-tool-session", { role: "user", content: "最近问题", _timestamp: 10 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-tool-session", summaryToolWorkspace, summaryToolManager, {}, client);

      expect(await collect(session.chat("当前问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
      ]);

      expect(client.calls[0]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: "我来查一下" }),
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

  it("keeps full readable history when summaries are disabled, ignoring legacy window limits", async () => {
    const oldText = "历史内容".repeat(2000);
    await appendSessionMessage(workspacePath, "no-summary", { role: "user", content: oldText });
    await appendSessionMessage(workspacePath, "no-summary", { role: "user", content: "recent" });
    const client = new SummaryModelClient([{ text: "done", toolCalls: [] }]);
    const session = new AgentSession("no-summary", workspacePath, manager, { contextCompressionThreshold: 0.1 }, client);
    expect((await collect(session.chat("continue"))).at(-1)).toMatchObject({ type: "done" });
    expect(client.completeCalls).toHaveLength(0);
    expect(client.calls[0]).toContainEqual(expect.objectContaining({ content: oldText }));
  });

  it("uses the same persistent summary engine in sub-agent sessions", async () => {
    await appendSessionMessage(workspacePath, "sub:summary", { role: "user", content: "旧内容".repeat(10000) });
    const client = new SummaryModelClient([{ text: "done", toolCalls: [] }]);
    const session = new AgentSession("sub:summary", workspacePath, manager, {
      contextCompressionThreshold: 0.1, sessionSummary: { enabled: true, recentTurns: 0 },
    }, client);
    expect((await collect(session.chat("continue"))).at(-1)).toMatchObject({ type: "done" });
    expect(client.completeCalls).toHaveLength(1);
    expect(loadSessionSummary(workspacePath, session.id).summarizedThroughSequence).toBe(1);
  });

  it("does not summarize an injected session summary again during context compression", async () => {
    const summaryCompressWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 1 },
      maxTokens: 1000,
      maxContextTokens: 16_000,
      contextCompressionThreshold: 0.7,
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
    await appendSessionMessage(summaryCompressWorkspace, "summary-compress-session", { role: "user", content: "recent user raw", _timestamp: 1 });
    await appendSessionMessage(summaryCompressWorkspace, "summary-compress-session", {
        role: "assistant",
        content: [{ type: "text", text: "recent assistant raw" }],
        _timestamp: 2,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-compress-session", summaryCompressWorkspace, summaryCompressManager, {}, client);

      expect(await collect(session.chat("current user raw"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
      ]);

      expect(client.completeCalls).toHaveLength(0);
      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "recent user raw" }),
        expect.objectContaining({ role: "user", content: "current user raw" }),
      ]));
      expect(JSON.stringify(client.calls[0])).not.toContain("session_memory_summary");
      expect(client.systemPrompts[0]).toContain("已有滚动摘要");
    } finally {
      await summaryCompressManager.destroy();
      removeTempWorkspace(summaryCompressWorkspace);
    }
  });

  it("does not reinterpret raw legacy-looking text when summaries are disabled", async () => {
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
    await appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "user", content: "[当前会话摘要]\n旧会话摘要", _timestamp: 1 });
    await appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "user", content: "[以下是对话历史的摘要]\n较早历史摘要", _timestamp: 2 });
    await appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "user", content: "[以下是对话历史的摘要]\n最新历史摘要", _timestamp: 3 });
    await appendSessionMessage(summaryNormalizeWorkspace, "summary-normalize-session", { role: "assistant", content: [{ type: "text", text: "上一轮最终回答" }], _timestamp: 4 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("summary-normalize-session", summaryNormalizeWorkspace, summaryNormalizeManager, {}, client);

      expect(await collect(session.chat("继续"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
      ]);

      const syntheticSummaries = client.calls[0].filter((message) => typeof message.content === "string"
        && (message.content.startsWith("[当前会话摘要]") || message.content.startsWith("[以下是对话历史的摘要]")));
      expect(syntheticSummaries).toHaveLength(3);
      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "上一轮最终回答" }],
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
      expect(client.completeCalls).toHaveLength(0);
      expect(client.systemPrompts[0]).not.toContain('<context_compression_summary');
      expect(client.calls[0]).toContainEqual(expect.objectContaining({ content: expect.stringContaining("最新历史摘要") }));
    } finally {
      await summaryNormalizeManager.destroy();
      removeTempWorkspace(summaryNormalizeWorkspace);
    }
  });

  it.each([true, false])("retains historical tool results below budget (summary=%s)", async (enabled) => {
    const previousToolWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled },
      maxTokens: 1000,
      maxContextTokens: 16_000,
      contextCompressionThreshold: 0.7,
      historyWindowSize: 10,
    });
    const previousToolManager = new PluginManager(previousToolWorkspace);
    try {
      await previousToolManager.loadCorePlugins();
    await appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "user",
        content: "上一轮搜索",
        _timestamp: 1,
      });
    await appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "assistant",
        content: [
          { type: "text", text: "我来搜索" },
          { type: "tool_use", id: "search-1", name: "web_search", input: { query: "large" } },
        ],
        _timestamp: 2,
      });
    await appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "search-1", content: "上一轮工具结果".repeat(20) }],
        _timestamp: 3,
      });
    await appendSessionMessage(previousToolWorkspace, "previous-tool-session", {
        role: "assistant",
        content: [{ type: "text", text: "上一轮最终回答" }],
        _timestamp: 4,
      });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("previous-tool-session", previousToolWorkspace, previousToolManager, {}, client);

      expect(await collect(session.chat("新一轮问题"))).toEqual([
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
      ]);

      expect(client.completeCalls).toHaveLength(0);
      expect(client.calls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "上一轮搜索" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "我来搜索" }, { type: "tool_use", id: "search-1", name: "web_search", input: { query: "large" } }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "上一轮最终回答" }],
        }),
        expect.objectContaining({ role: "user", content: "新一轮问题" }),
      ]));
      expect(client.calls[0]).toEqual(expect.arrayContaining([
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

  it("summarizes historical tools at the token threshold and preserves the original on disk and restart", async () => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, contextCompressionThreshold: 0.05, contextCompressionTargetRatio: 0.025, sessionSummary: { maxBudgetRatio: 0.01, enabled: true } });
    const firstManager = new PluginManager(workspace);
    const secondManager = new PluginManager(workspace);
    try {
      await firstManager.loadCorePlugins();
      const source = [
        { role: "user" as const, content: "old task".repeat(3000) },
        { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "old-tool", name: "bash", input: { command: "test" } }] },
        { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "old-tool", content: "历史工具结果".repeat(3500) }] },
        { role: "assistant" as const, content: "finished" },
      ];
      for (const message of source) await appendSessionMessage(workspace, "tool-summary", message);
      const client = new SummaryModelClient([{ text: "done", toolCalls: [] }]);
      await collect(new AgentSession("tool-summary", workspace, firstManager, {}, client).chat("new task"));
      expect(client.completeCalls).toHaveLength(1);
      const request = JSON.parse(String(client.completeCalls[0][0].content));
      expect(request.batch.throughSequence).toBe(4);
      expect(request.messages.map((message: { content: string }) => message.content)).toEqual([source[0].content, "finished"]);
      expect(JSON.stringify(request.messages)).not.toContain("old-tool");
      expect(JSON.stringify(request.messages)).not.toContain("历史工具结果");
      expect(JSON.stringify(client.calls[0])).not.toContain("old-tool");
      expect(JSON.stringify(readSessionMessages(workspace, "tool-summary"))).toContain("old-tool");
      await secondManager.loadCorePlugins();
      const restored = new SummaryModelClient([{ text: "restored", toolCalls: [] }]);
      await collect(new AgentSession("tool-summary", workspace, secondManager, {}, restored).chat("continue"));
      expect(restored.completeCalls).toHaveLength(0);
      expect(restored.systemPrompts[0]).toContain("持久化摘要");
      expect(JSON.stringify(restored.calls[0])).toContain("new task");
    } finally {
      await firstManager.destroy();
      await secondManager.destroy();
      removeTempWorkspace(workspace);
    }
  });

  it("continues with bounded current tool results without truncating the original", async () => {
    const toolBudgetWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
      maxContextTokens: 20_000,
      maxTokens: 1000,
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

      const events = await collect(session.chat("继续总结"));
      expect(events.at(-1)).toMatchObject({ type: "done", text: "完成" });
      expect(client.calls).toHaveLength(2);
      expect(JSON.stringify(client.calls[1])).toContain("contentRef");
      expect(JSON.stringify(client.calls[1])).not.toContain("超大搜索结果".repeat(20_000));
      expect(readSessionMessages(toolBudgetWorkspace, session.id)).toContainEqual(expect.objectContaining({
        content: [expect.objectContaining({ type: "tool_result", content: "超大搜索结果".repeat(20_000) })],
      }));
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
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    const client = new FakeModelClient([
      (_messages, _tools, _systemPrompt, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        modelStarted();
      }),
    ]);
    const session = new AgentSession("cancel", workspacePath, manager, {}, client);
    const running = collect(session.chat("wait"));
    await started;

    expect(session.isBusy()).toBe(true);
    expect(await collect(session.chat("second"))).toEqual([
      { type: "error", message: "会话正在执行中，请等待完成或先取消当前任务" },
    ]);
    expect(session.cancel()).toBe(true);
    expect(await running).toEqual([{ type: "error", message: "会话已取消" }]);
    expect(session.isBusy()).toBe(false);
    expect(session.cancel()).toBe(false);
  });

  it("does not call the model when cancelled during context snapshot preparation", async () => {
    let prepared!: () => void;
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => { prepared = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    addHooks(manager, {
      async onModelRequestPrepared() {
        prepared();
        await paused;
      },
    });
    const client = new FakeModelClient([]);
    const session = new AgentSession("cancel-preparation", workspacePath, manager, {}, client);
    const running = collect(session.chat("wait"));
    await preparing;
    expect(session.cancel()).toBe(true);
    release();
    expect(await running).toEqual([{ type: "error", message: "会话已取消" }]);
    expect(client.calls).toHaveLength(0);
    expect(session.isBusy()).toBe(false);
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
      { type: "tool_call", toolCallId: "call-1", name: "echo", input: {}, startedAt: expect.any(Number) },
      { type: "tool_result", toolCallId: "call-1", name: "echo", result: "ok", completedAt: expect.any(Number) },
      {
        type: "text_delta",
        text: "\n\n任务已停止：Agent 已达到最大迭代次数（1 次），当前任务可能尚未完成。你可以继续发送“继续”，或在设置中调整 maxAgentIterations。",
      },
      {
        type: "done",
        text: "partial\n\n任务已停止：Agent 已达到最大迭代次数（1 次），当前任务可能尚未完成。你可以继续发送“继续”，或在设置中调整 maxAgentIterations。",
        reason: "iteration_limit",
      },
    ]);
    expect(session.getMessages().at(-1)).toEqual({
      role: "assistant",
      _source: "runtime_notice",
      _turnId: expect.any(String),
      _messageId: expect.any(String),
      _sequence: expect.any(Number),
      content: [{
        type: "text",
        text: "任务已停止：Agent 已达到最大迭代次数（1 次），当前任务可能尚未完成。你可以继续发送“继续”，或在设置中调整 maxAgentIterations。",
      }],
      _timestamp: expect.any(Number),
    });
  });

  it("carries an iteration-limited tool-heavy turn into the next model request", async () => {
    const limitedWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: true, persistent: true, turnThreshold: 100, recentTurns: 1 },
      historyWindowSize: 1,
      maxAgentIterations: 1,
    });
    const limitedManager = new PluginManager(limitedWorkspace);
    try {
      await limitedManager.loadCorePlugins();
      registerTool(limitedManager, {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "large tool output",
      });
      const client = new SummaryModelClient([
        {
          text: "正在处理原任务",
          toolCalls: [{ type: "tool_use", id: "call-limit", name: "echo", input: {} }],
        },
        { text: "继续完成", toolCalls: [] },
      ]);
      const session = new AgentSession("limited-history", limitedWorkspace, limitedManager, {}, client);

      await collect(session.chat("需要完整保留的原始任务"));
      expect(session.getMessages()).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "需要完整保留的原始任务" }),
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([{ type: "text", text: "正在处理原任务" }]),
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([expect.objectContaining({
            type: "text",
            text: expect.stringContaining("达到最大迭代次数"),
          })]),
        }),
      ]));

      await collect(session.chat("继续"));
      expect(client.systemPrompts[1]).toContain("达到最大迭代次数");
      expect(JSON.stringify(client.calls[1])).not.toContain("达到最大迭代次数");
      expect(client.calls[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "需要完整保留的原始任务" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "正在处理原任务" }, { type: "tool_use", id: "call-limit", name: "echo", input: {} }],
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
      expect(client.calls[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ type: "tool_result" })]),
        }),
      ]));
    } finally {
      await limitedManager.destroy();
      removeTempWorkspace(limitedWorkspace);
    }
  });

  it("applies project ask permissions to the actual tool execution", async () => {
    const projectWorkspace = createTempWorkspace({
      autoMemory: { enabled: false },
      sessionSummary: { enabled: false },
      security: { mode: "allow", tools: {} },
      project: { security: { mode: "ask", tools: { file_write: { mode: "ask" } } } },
    });
    const projectManager = new PluginManager(projectWorkspace);
    try {
      await projectManager.loadCorePlugins();
      const client = new FakeModelClient([
        {
          text: "准备写入",
          toolCalls: [{ type: "tool_use", id: "write-1", name: "file_write", input: { path: "blocked.txt", content: "no" } }],
        },
      ]);
      const context = { mode: "project" as const, project: { root: projectWorkspace, name: "project" } };
      const session = new AgentSession("project-permission", projectWorkspace, projectManager, {}, client, context);

      await collect(session.chat("写一个文件"));

      expect(existsSync(resolve(projectWorkspace, "blocked.txt"))).toBe(false);
      expect(client.calls).toHaveLength(1);
      expect(listApprovals(projectWorkspace)).toEqual([
        expect.objectContaining({ toolName: "file_write", sessionId: "project-permission" }),
      ]);
      expect(client.calls[0].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "写一个文件" }),
      ]));
    } finally {
      await projectManager.destroy();
      removeTempWorkspace(projectWorkspace);
    }
  });
});
