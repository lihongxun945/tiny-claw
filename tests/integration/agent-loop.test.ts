import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { attachmentToImageBlock, saveAttachment } from "../../src/attachments.js";
import { loadConfig } from "../../src/config.js";
import type { ModelClient } from "../../src/model/index.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { loadSessionState, saveSessionState, updateSessionState } from "../../src/session-state.js";
import { appendSessionMessage, sessionMessagesPath, sessionStateFilePath } from "../../src/session-store.js";
import { getMemoryRecord, saveMemory } from "../../src/tools/memory.js";
import { approveTurnRequest, hasTurnApproval, listApprovals } from "../../src/tools/approval.js";
import { checkDangerousToolPermission } from "../../src/tools/permission.js";
import type { ChatResponse, Message, Tool, ToolDefinition } from "../../src/types.js";
import { runWorkspaceAutoMemoryAnalysis } from "../../src/plugins/core/auto-memory.js";
import { readSessionPlan } from "../../src/plan-store.js";
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
      { type: "tool_call", toolCallId: "call-1", name: "echo", input: { text: "value" } },
      { type: "tool_result", toolCallId: "call-1", name: "echo", result: "echo:value" },
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

  it("creates and completes a persisted plan before finishing plan mode", async () => {
    registerTool(manager, {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "ok",
    });
    const toolCall = (id: string, name: string, input: Record<string, unknown>): ChatResponse => ({
      text: "",
      toolCalls: [{ type: "tool_use", id, name, input }],
    });
    const client = new FakeModelClient([
      toolCall("plan-1", "plan_create", { steps: ["分析", "实现"] }),
      toolCall("plan-2", "plan_update", { step_id: "step-1", status: "in_progress" }),
      toolCall("work-1", "echo", {}),
      toolCall("plan-3", "plan_update", { step_id: "step-1", status: "completed", summary: "分析完成" }),
      toolCall("plan-4", "plan_update", { step_id: "step-2", status: "in_progress" }),
      toolCall("plan-5", "plan_update", { step_id: "step-2", status: "completed", summary: "实现完成" }),
      { text: "全部完成", toolCalls: [] },
    ]);
    const session = new AgentSession("plan-loop", workspacePath, manager, {}, client);

    const planTurnId = "11111111-1111-4111-8111-111111111111";
    const events = await collect(session.chat("执行任务", undefined, undefined, "plan", planTurnId));
    expect(events.at(-1)).toEqual({ type: "done", text: "全部完成", reason: "completed" });
    expect(client.calls[0].tools?.map((tool) => tool.name)).toEqual(["plan_create"]);
    expect(client.calls[1].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["plan_update", "plan_revise"]));
    expect(client.calls[1].tools?.map((tool) => tool.name)).not.toContain("echo");
    expect(client.calls[2].tools?.map((tool) => tool.name)).toContain("echo");
    expect(events).toEqual(expect.arrayContaining([
      { type: "status", stage: "plan", state: "started", message: "正在生成执行计划…" },
      { type: "status", stage: "plan", state: "started", message: "正在执行第 1/2 步：分析" },
      { type: "status", stage: "plan", state: "started", message: "计划已完成，正在整理最终结果…" },
    ]));
    expect(client.calls[0].systemPrompt).toContain("计划执行模式");
    const persistedPlan = readSessionPlan(workspacePath, "plan-loop", planTurnId);
    expect(persistedPlan?.status).toBe("completed");
    expect(persistedPlan?.currentStepId).toBeUndefined();

    const normalClient = new FakeModelClient([{ text: "普通回复", toolCalls: [] }]);
    const normalSession = new AgentSession("normal-loop", workspacePath, manager, {}, normalClient);
    await collect(normalSession.chat("普通任务"));
    expect(normalClient.calls[0].tools?.some((tool) => tool.name === "plan_create")).toBe(false);
    expect(normalClient.calls[0].systemPrompt).not.toContain("计划执行模式");
  });

  it("answers directly in plan mode when no tool execution is needed", async () => {
    const client = new FakeModelClient([{ text: "RAG 更适合语义检索。", toolCalls: [] }]);
    const session = new AgentSession("plan-direct-answer", workspacePath, manager, {}, client);
    const turnId = "22222222-2222-4222-8222-222222222222";

    expect((await collect(session.chat("关键词检索和 RAG 如何选择？", undefined, undefined, "plan", turnId))).at(-1)).toEqual({
      type: "done",
      text: "RAG 更适合语义检索。",
      reason: "completed",
    });
    expect(client.calls[0].tools?.map((tool) => tool.name)).toEqual(["plan_create"]);
    expect(client.calls[0].systemPrompt).toContain("无需调用任何工具");
    expect(readSessionPlan(workspacePath, "plan-direct-answer", turnId)).toBeUndefined();
  });

  it("pauses a plan for user input and resumes it in a later turn", async () => {
    const toolCall = (id: string, name: string, input: Record<string, unknown>): ChatResponse => ({
      text: "",
      toolCalls: [{ type: "tool_use", id, name, input }],
    });
    const firstTurnId = "33333333-3333-4333-8333-333333333333";
    const secondTurnId = "44444444-4444-4444-8444-444444444444";
    const client = new FakeModelClient([
      toolCall("create", "plan_create", { steps: ["给出方案", "实施"] }),
      toolCall("start-1", "plan_update", { step_id: "step-1", status: "in_progress" }),
      toolCall("pause", "plan_pause", { summary: "等待用户确认方案" }),
      { text: "请确认方案", toolCalls: [] },
      toolCall("resume-1", "plan_update", { step_id: "step-1", status: "in_progress" }),
      toolCall("complete-1", "plan_update", { step_id: "step-1", status: "completed", summary: "用户已确认" }),
      toolCall("start-2", "plan_update", { step_id: "step-2", status: "in_progress" }),
      toolCall("complete-2", "plan_update", { step_id: "step-2", status: "completed", summary: "实施完成" }),
      { text: "任务完成", toolCalls: [] },
    ]);
    const session = new AgentSession("plan-user-pause", workspacePath, manager, {}, client);

    expect((await collect(session.chat("先给方案", undefined, undefined, "plan", firstTurnId))).at(-1)).toEqual({
      type: "done", text: "请确认方案", reason: "completed",
    });
    expect(readSessionPlan(workspacePath, "plan-user-pause", firstTurnId)?.steps[0].status).toBe("waiting_user");

    expect((await collect(session.chat("确认", undefined, undefined, "plan", secondTurnId))).at(-1)).toEqual({
      type: "done", text: "任务完成", reason: "completed",
    });
    expect(readSessionPlan(workspacePath, "plan-user-pause", firstTurnId)?.status).toBe("completed");
    expect(readSessionPlan(workspacePath, "plan-user-pause", secondTurnId)).toBeUndefined();
    expect(client.calls[4].systemPrompt).toContain("不要调用 plan_create");
  });

  it("revises pending steps after a research step", async () => {
    registerTool(manager, {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "调研结果",
    });
    const toolCall = (id: string, name: string, input: Record<string, unknown>): ChatResponse => ({
      text: "",
      toolCalls: [{ type: "tool_use", id, name, input }],
    });
    const client = new FakeModelClient([
      toolCall("create", "plan_create", { steps: ["调研现状", "根据调研细化计划"] }),
      toolCall("start-research", "plan_update", { step_id: "step-1", status: "in_progress" }),
      toolCall("research", "echo", {}),
      toolCall("complete-research", "plan_update", { step_id: "step-1", status: "completed", summary: "调研完成" }),
      toolCall("revise", "plan_revise", { steps: ["修改实现", "运行测试"] }),
      toolCall("start-code", "plan_update", { step_id: "step-3", status: "in_progress" }),
      toolCall("complete-code", "plan_update", { step_id: "step-3", status: "completed" }),
      toolCall("start-test", "plan_update", { step_id: "step-4", status: "in_progress" }),
      toolCall("complete-test", "plan_update", { step_id: "step-4", status: "completed" }),
      { text: "完成", toolCalls: [] },
    ]);
    const session = new AgentSession("plan-revise", workspacePath, manager, {}, client);
    const reviseTurnId = "55555555-5555-4555-8555-555555555555";

    expect((await collect(session.chat("复杂任务", undefined, undefined, "plan", reviseTurnId))).at(-1)).toEqual({
      type: "done", text: "完成", reason: "completed",
    });
    const plan = readSessionPlan(workspacePath, "plan-revise", reviseTurnId);
    expect(plan?.revision).toBe(1);
    expect(plan?.steps.map((step) => step.title)).toEqual(["调研现状", "修改实现", "运行测试"]);
    expect(client.calls[0].tools?.map((tool) => tool.name)).toEqual(["plan_create"]);
    expect(client.calls[4].tools?.map((tool) => tool.name)).toContain("plan_revise");
    expect(client.calls[0].systemPrompt).toContain("调研完成后调用 plan_revise");
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
        { type: "tool_call", toolCallId: "call-1", name: "echo", input: { text: "value" } },
        { type: "tool_result", toolCallId: "call-1", name: "echo", result: "工具过程结果" },
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
      appendSessionMessage(autoWorkspace, "session-a", { role: "user", content: "会话 A", _timestamp: 1 });
      appendSessionMessage(autoWorkspace, "session-b", { role: "user", content: "会话 B", _timestamp: 2 });
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
      name: "missing",
      result: JSON.stringify({ error: "未知工具: missing" }),
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolCallId: "fail",
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
      { type: "tool_call", toolCallId: "call-1", name: "gated", input: {} },
      {
        type: "tool_result",
        toolCallId: "call-1",
        name: "gated",
        result: JSON.stringify({ error: "需要批准", requiresConfirmation: true, approvalId: "approval-1" }),
      },
      { type: "done", text: "先申请授权", reason: "approval_required" },
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
      { type: "tool_call", toolCallId: "call-1", name: "gated", input: {} },
      { type: "tool_result", toolCallId: "call-1", name: "gated", result: "approved-result" },
      { type: "text_delta", text: "继续后的总结" },
      { type: "done", text: "继续后的总结", reason: "completed" },
    ]);
    expect(client.calls).toHaveLength(2);
    expect(gatedTool).toHaveBeenCalledTimes(2);
    expect(laterTool).not.toHaveBeenCalled();
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

    expect(resumed).toContainEqual({ type: "tool_result", toolCallId: "call-1", name: "dangerous", result: "ran-first" });
    expect(resumed).toContainEqual({ type: "tool_result", toolCallId: "call-2", name: "dangerous", result: "ran-second" });
    expect(dangerousTool).toHaveBeenCalledTimes(3);
    expect(hasTurnApproval(workspacePath, session.id)).toBe(false);
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
      { type: "done", text: "done", reason: "completed" },
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
        { type: "done", text: "第一轮完成", reason: "completed" },
      ]);
      expect(loadSessionState(summaryWorkspace, "summary-session").summary).toContain("持久化摘要");

      await secondManager.loadCorePlugins();
      const secondClient = new SummaryModelClient([{ text: "第二轮完成", toolCalls: [] }]);
      const secondSession = new AgentSession("summary-session", summaryWorkspace, secondManager, {}, secondClient);

      expect(await collect(secondSession.chat("继续"))).toEqual([
        { type: "text_delta", text: "第二轮完成" },
        { type: "done", text: "第二轮完成", reason: "completed" },
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
        { type: "done", text: "完成", reason: "completed" },
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
        { type: "done", text: "完成", reason: "completed" },
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
      maxTokens: 1000,
      maxContextTokens: 10_000,
      contextCompressionThreshold: 0.1,
      historyWindowSize: 10,
    });
    const compressManager = new PluginManager(compressWorkspace);
    try {
      await compressManager.loadCorePlugins();
      const oldText = "旧历史内容".repeat(200);
      appendSessionMessage(compressWorkspace, "compress-session", { role: "user", content: `old user ${oldText}`, _timestamp: 1 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "assistant", content: [{ type: "text", text: `old assistant ${oldText}` }], _timestamp: 2 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "user", content: `older user ${oldText}`, _timestamp: 3 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "assistant", content: [{ type: "text", text: `older assistant ${oldText}` }], _timestamp: 4 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "user", content: "recent user raw", _timestamp: 5 });
      appendSessionMessage(compressWorkspace, "compress-session", { role: "assistant", content: [{ type: "text", text: "recent assistant raw" }], _timestamp: 6 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("compress-session", compressWorkspace, compressManager, {}, client);

      expect(await collect(session.chat("current user raw"))).toEqual([
        { type: "status", stage: "context_compression", state: "started", message: "正在压缩上下文…", beforeTokens: expect.any(Number) },
        { type: "status", stage: "context_compression", state: "completed", message: "上下文压缩完成，正在调用模型…", beforeTokens: expect.any(Number), afterTokens: expect.any(Number) },
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
      ]);

      expect(client.completeCalls[0][0].content).toContain("不超过 5000 字");
      expect(client.calls[0]).toEqual([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("[当前会话摘要]"),
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
      maxTokens: 1000,
      maxContextTokens: 10_000,
      contextCompressionThreshold: 0.1,
      contextCompressionMaxChars: 1200,
      historyWindowSize: 10,
    });
    const compressLengthManager = new PluginManager(compressLengthWorkspace);
    try {
      await compressLengthManager.loadCorePlugins();
      const oldText = "旧历史内容".repeat(200);
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "user", content: `old user ${oldText}`, _timestamp: 1 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "assistant", content: [{ type: "text", text: `old assistant ${oldText}` }], _timestamp: 2 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "user", content: `older user ${oldText}`, _timestamp: 3 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "assistant", content: [{ type: "text", text: `older assistant ${oldText}` }], _timestamp: 4 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "user", content: "recent user raw", _timestamp: 5 });
      appendSessionMessage(compressLengthWorkspace, "compress-length-session", { role: "assistant", content: [{ type: "text", text: "recent assistant raw" }], _timestamp: 6 });

      const client = new SummaryModelClient([{ text: "完成", toolCalls: [] }]);
      const session = new AgentSession("compress-length-session", compressLengthWorkspace, compressLengthManager, {}, client);

      expect(await collect(session.chat("current user raw"))).toEqual([
        { type: "status", stage: "context_compression", state: "started", message: "正在压缩上下文…", beforeTokens: expect.any(Number) },
        { type: "status", stage: "context_compression", state: "completed", message: "上下文压缩完成，正在调用模型…", beforeTokens: expect.any(Number), afterTokens: expect.any(Number) },
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
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
      maxTokens: 1000,
      maxContextTokens: 10_000,
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
        { type: "done", text: "完成", reason: "completed" },
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
        { type: "done", text: "完成", reason: "completed" },
      ]);

      const syntheticSummaries = client.calls[0].filter((message) => typeof message.content === "string"
        && (message.content.startsWith("[当前会话摘要]") || message.content.startsWith("[以下是对话历史的摘要]")));
      expect(syntheticSummaries).toEqual([
        expect.objectContaining({ content: "[当前会话摘要]\n旧会话摘要" }),
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
      maxTokens: 1000,
      maxContextTokens: 10_000,
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
        { type: "done", text: "完成", reason: "completed" },
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

      expect(await collect(session.chat("继续总结"))).toEqual([
        { type: "tool_call", toolCallId: "search-1", name: "large_result", input: {} },
        { type: "tool_result", toolCallId: "search-1", name: "large_result", result: "超大搜索结果".repeat(20_000) },
        { type: "text_delta", text: "完成" },
        { type: "done", text: "完成", reason: "completed" },
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
      { type: "tool_call", toolCallId: "call-1", name: "echo", input: {} },
      { type: "tool_result", toolCallId: "call-1", name: "echo", result: "ok" },
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
      _turnId: expect.any(String),
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
      const state = loadSessionState(limitedWorkspace, "limited-history");
      expect(state.pendingMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "需要完整保留的原始任务" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "正在处理原任务" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({
            type: "text",
            text: expect.stringContaining("达到最大迭代次数"),
          })],
        }),
      ]));

      await collect(session.chat("继续"));
      expect(client.calls[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "需要完整保留的原始任务" }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "正在处理原任务" }],
        }),
        expect.objectContaining({ role: "user", content: "继续" }),
      ]));
      expect(client.calls[1]).not.toEqual(expect.arrayContaining([
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
