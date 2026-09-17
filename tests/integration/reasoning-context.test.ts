import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { loadConfig } from "../../src/config.js";
import { OpenAIChatClient } from "../../src/model/openai.js";
import { PluginManager } from "../../src/plugin-manager.js";
import type { PluginContext } from "../../src/plugins/types.js";
import { saveSessionState } from "../../src/session-state.js";
import { readSessionMessages } from "../../src/session-store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("thinking protocol with derived context", () => {
  it.each([false, true])("preserves thinking across summary and approval without tool replay (API failure=%s)", async failure => {
    const workspace = createTempWorkspace({ modelProvider: "openai-chat", autoMemory: { enabled: false },
      sessionSummary: { enabled: true } });
    const manager = new PluginManager(workspace);
    try {
      await manager.loadCorePlugins();
      saveSessionState(workspace, { sessionId: "thinking", summary: "历史目标资料", pendingMessages: [], turnsSinceSummary: 0 });
      const ctx = (manager as unknown as { createPluginContext: (id: string) => PluginContext }).createPluginContext("test-thinking");
      const read = vi.fn(async () => "read result");
      const executed = vi.fn(async () => "approved result");
      let approved = false;
      ctx.registerTool({ name: "read_test", description: "read", inputSchema: { type: "object" }, execute: read });
      ctx.registerTool({ name: "gate_test", description: "gate", inputSchema: { type: "object" },
        execute: async () => approved ? executed() : JSON.stringify({ requiresConfirmation: true, approvalId: "approval" }) });

      let requests = 0;
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        requests++;
        const body = JSON.parse(String(init?.body)) as { stream: boolean; messages: Array<{
          role: string; content: string | null; reasoning_content?: string;
          tool_calls?: Array<{ id: string }>; tool_call_id?: string;
        }> };
        expect(body.stream).toBe(true);
        expect(body.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("历史目标资料") });
        const assistants = body.messages.filter(m => m.role === "assistant");
        expect(assistants.every(m => typeof m.reasoning_content === "string")).toBe(true);
        expect(assistants.every(m => !String(m.content).includes("session_memory_summary"))).toBe(true);
        expect(assistants.map(m => m.reasoning_content)).toEqual(requests === 1 ? [] : requests === 2 ? ["reasoning-original"] : ["reasoning-original", ""]);
        if (requests === 3) {
          expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "gate-call", content: "approved result" });
          if (failure) return new Response(JSON.stringify({ error: { message: "The `reasoning_content` in the thinking mode must be passed back to the API." } }), { status: 400 });
        }
        const delta = requests < 3 ? {
          reasoning_content: requests === 1 ? "reasoning-original" : "",
          tool_calls: [{ index: 0, id: requests === 1 ? "read-call" : "gate-call",
            function: { name: requests === 1 ? "read_test" : "gate_test", arguments: "{}" } }],
        } : { reasoning_content: "final reasoning", content: "done" };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const session = new AgentSession("thinking", workspace, manager, {}, new OpenAIChatClient(loadConfig(workspace)));
      expect((await collect(session.chat("continue"))).at(-1)).toMatchObject({ type: "done", reason: "approval_required" });
      approved = true;
      const events = await collect(session.resumeApproval("approval"));
      expect(events.at(-1)).toMatchObject(failure ? { type: "error", message: expect.stringContaining("400") } : { type: "done", text: "done" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(read).toHaveBeenCalledTimes(1);
      expect(executed).toHaveBeenCalledTimes(1);
      const history = readSessionMessages(workspace, session.id);
      expect(JSON.stringify(history)).toContain("approved result");
      expect(JSON.stringify(history)).not.toContain("session_memory_summary");
      expect(history.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_use" && b.id === "gate-call"))?._reasoningContent).toBe("");
    } finally {
      vi.unstubAllGlobals();
      await manager.destroy();
      removeTempWorkspace(workspace);
    }
  });
});
