import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("returns an error event when the model call fails", async () => {
    const client = new FakeModelClient([new Error("model unavailable")]);
    const session = new AgentSession("model-error", workspacePath, manager, {}, client);

    expect(await collect(session.chat("hi"))).toEqual([
      { type: "error", message: "model unavailable" },
    ]);
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
