import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { listRuns } from "../../src/run-store.js";
import { readSessionMessages } from "../../src/session-store.js";
import { validateToolMessageChains } from "../../src/message-sanitizer.js";
import { FakeModelClient } from "../helpers/fake-model-client.js";
import type { PluginContext } from "../../src/plugins/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

async function collect(events: AsyncIterable<AgentEvent>) { const all: AgentEvent[] = []; for await (const event of events) all.push(event); return all; }
const ask = { type: "tool_use" as const, id: "ask-1", name: "ask_user", input: { question: "Choose a size", type: "single_choice", options: [{ id: "small", label: "40 games" }, { id: "large", label: "160 games" }] } };

describe("user input suspension", () => {
  it.each([false, true])("persists questions and answers exactly once (cancel=%s)", async (cancel) => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, sessionSummary: { enabled: false } });
    const manager = new PluginManager(workspace);
    const restoredManager = new PluginManager(workspace);
    try {
      await manager.loadCorePlugins();
      const execute = vi.fn(async () => "should not run");
      (manager as unknown as { createPluginContext: (name: string) => PluginContext }).createPluginContext("test-user-input").registerTool({ name: "effect", description: "test", inputSchema: { type: "object" }, execute });
      const client = new FakeModelClient([{ text: "Please choose", toolCalls: [ask, { type: "tool_use", id: "after-ask", name: "effect", input: {} }] }]);
      const session = new AgentSession("question-session", workspace, manager, {}, client);
      const events = await collect(session.chat("start", undefined, undefined, "normal", "question-turn"));
      expect(events.at(-1)).toMatchObject({ type: "done", reason: "waiting_user" });
      expect(session.isBusy()).toBe(false);
      const pending = session.getPendingSuspension()!;
      expect(pending.completedAt).toBeUndefined();
      expect(pending.suspension?.skippedToolCalls).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect((await collect(session.chat("another task")))[0]).toMatchObject({ type: "error" });
      await manager.destroy();
      await restoredManager.loadCorePlugins();
      const next = new FakeModelClient([(messages) => {
        expect(validateToolMessageChains(messages)).toBeUndefined();
        expect(JSON.stringify(messages)).toContain("selectedIds");
        return { text: "Continuing with the answer", toolCalls: [] };
      }]);
      const restored = new AgentSession("question-session", workspace, restoredManager, {}, next);
      if (cancel) {
        expect(await restored.cancelPendingSuspension()).toBe(true);
        expect(listRuns(workspace, restored.id).at(-1)?.state).toBe("cancelled");
      } else {
        const result = JSON.stringify({ status: "answered", selectedIds: ["small"], text: "" });
        const continuation = await collect(restored.resumeTool(pending.suspension!.id, result));
        expect(continuation.at(-1)).toMatchObject({ type: "done", reason: "completed" });
        expect(listRuns(workspace, restored.id)).toHaveLength(1);
        expect(listRuns(workspace, restored.id)[0].startedAt).toBe(pending.startedAt);
        expect(readSessionMessages(workspace, restored.id).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result" && block.tool_use_id === ask.id)).toHaveLength(1);
      }
      expect((await collect(restored.resumeTool(pending.suspension!.id, "late")))[0]).toMatchObject({ type: "error" });
      expect(execute).not.toHaveBeenCalled();
    } finally { await manager.destroy(); await restoredManager.destroy(); removeTempWorkspace(workspace); }
  });
});
