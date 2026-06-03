import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { PluginManager } from "../../src/plugin-manager.js";
import type { Tool } from "../../src/types.js";
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
    const records = readFileSync(resolve(workspacePath, "history", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      role: "user",
      _session: "tool-loop",
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

  it("repairs incomplete persisted tool chains when restoring a session", async () => {
    const historyPath = resolve(workspacePath, "history", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(historyPath, [
      JSON.stringify({
        role: "user",
        content: "legacy request",
        _session: "restore",
      }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "legacy text" },
          { type: "tool_use", id: "missing-result", name: "echo", input: {} },
        ],
        _session: "restore",
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", id: "complete-result", name: "echo", input: {} }],
        _session: "restore",
      }),
      JSON.stringify({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "complete-result", content: "ok" }],
        _session: "restore",
      }),
      "",
    ].join("\n"), "utf-8");

    const client = new FakeModelClient([
      (messages) => {
        expect(messages).toEqual([
          expect.objectContaining({ role: "user", content: "legacy request" }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "legacy text" }],
          }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "tool_use", id: "complete-result", name: "echo", input: {} }],
          }),
          expect.objectContaining({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "complete-result", content: "ok" }],
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
