import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { PluginManager } from "../../src/plugin-manager.js";
import type { PluginContext } from "../../src/plugins/types.js";
import { loadConfig } from "../../src/config.js";
import { readSessionMessages, sessionDir } from "../../src/session-store.js";
import { loadSessionSummary } from "../../src/session-memory/store.js";
import { validateToolMessageChains } from "../../src/message-sanitizer.js";
import { estimateTokens } from "../../src/estimate-tokens.js";
import { FakeModelClient, type ScriptedChat } from "../helpers/fake-model-client.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

async function collect(events: AsyncIterable<AgentEvent>) { const all: AgentEvent[] = []; for await (const e of events) all.push(e); return all; }
const context = (manager: PluginManager) => (manager as unknown as { createPluginContext: (id: string) => PluginContext }).createPluginContext("test-budget");

describe("tool context lifecycle", () => {
  it("finishes consecutive recall pages despite large history, without projecting back into memory", async () => {
    const workspace = createTempWorkspace({ maxContextTokens: 32000, maxTokens: 1000,
      autoMemory: { enabled: false }, sessionSummary: { enabled: false } });
    const manager = new PluginManager(workspace);
    try {
      await manager.loadCorePlugins();
      const body = "正文".repeat(3138) + "末";
      const original = JSON.stringify({ results: [{ title: "paper", url: "https://example.com", snippet: body }] });
      context(manager).registerTool({ name: "large_read", description: "read", inputSchema: { type: "object" },
        execute: async () => original });
      const scripts: ScriptedChat[] = Array.from({ length: 12 }, (_, i) => ({ text: "", toolCalls: [
        { type: "tool_use", id: `source-${i}`, name: "large_read", input: {} },
      ] }));
      let offset = 0;
      let collected = "";
      scripts.push({ text: "", toolCalls: [{ type: "tool_use", id: "page-0", name: "session_history_recall",
        input: { tool_call_id: "source-0", result_index: 0, offset } }] });
      const readPage: ScriptedChat = messages => {
        expect(validateToolMessageChains(messages)).toBeUndefined();
        const blocks = messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
        const block = blocks.at(-1)!;
        if (block.type !== "tool_result") throw new Error("missing page");
        const page = JSON.parse(block.content);
        expect(page.offset).toBe(offset);
        expect(page.nextOffset).toBe(offset + page.content.length);
        expect(page.content.length).toBeGreaterThanOrEqual(Math.min(1000, body.length - offset));
        collected += page.content;
        offset = page.nextOffset;
        if (!page.truncated) return { text: "done", toolCalls: [] };
        return { text: "", toolCalls: [{ type: "tool_use", id: `page-${offset}`, name: "session_history_recall",
          input: { tool_call_id: "source-0", result_index: 0, offset } }] };
      };
      scripts.push(...Array.from({ length: 5 }, () => readPage));
      const client = new FakeModelClient(scripts);
      const session = new AgentSession("recall-pages", workspace, manager, {}, client);
      const events = await collect(session.chat("read the source"));
      expect(events.filter(event => event.type === "error")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "done", text: "done" });
      expect(collected).toBe(body);
      expect(client.calls.length).toBeLessThanOrEqual(17);
      for (const messages of [session.getMessages(), readSessionMessages(workspace, session.id)]) {
        const source = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
          .find(b => b.type === "tool_result" && b.tool_use_id === "source-0");
        expect(source).toMatchObject({ content: original });
      }
    } finally { await manager.destroy(); removeTempWorkspace(workspace); }
  });

  it("handles the three-search incident, stores originals and paginates them after restart", async () => {
    const workspace = createTempWorkspace({ autoMemory: { enabled: false }, sessionSummary: { enabled: false } });
    const manager = new PluginManager(workspace);
    const restored = new PluginManager(workspace);
    try {
      await manager.loadCorePlugins();
      const originals = [60000, 285000, 71000].map(n => JSON.stringify({ results: [{ title: "paper", url: "https://example.com", snippet: "a".repeat(n) + "TARGET" }] }));
      const execute = vi.fn(async (args: Record<string, unknown>) => originals[Number(args.index)]);
      context(manager).registerTool({ name: "large_search", description: "search", inputSchema: { type: "object" }, execute });
      const calls = originals.map((_, index) => ({ type: "tool_use" as const, id: `search-${index}`, name: "large_search", input: { index } }));
      const client = new FakeModelClient([{ text: "", toolCalls: calls }, messages => {
        expect(validateToolMessageChains(messages)).toBeUndefined();
        expect(estimateTokens(messages)).toBeLessThan(30000);
        expect(JSON.stringify(messages)).toContain("contentRef");
        return { text: "done", toolCalls: [] };
      }]);
      const session = new AgentSession("large-search", workspace, manager, {}, client);
      expect((await collect(session.chat("research"))).at(-1)).toMatchObject({ type: "done" });
      expect(execute).toHaveBeenCalledTimes(3);
      const raw = readSessionMessages(workspace, session.id).flatMap(m => Array.isArray(m.content) ? m.content : []);
      expect(raw.filter(b => b.type === "tool_result").map(b => b.type === "tool_result" ? b.content : "")).toEqual(originals);
      await manager.destroy();
      await restored.loadCorePlugins();
      const recall = restored.getTool("session_history_recall")!;
      const options = { sessionId: session.id, config: loadConfig(workspace) };
      const page = JSON.parse(await recall.execute({ tool_call_id: "search-1", result_index: 0 }, options));
      const next = JSON.parse(await recall.execute({ tool_call_id: "search-1", result_index: 0, offset: page.nextOffset }, options));
      expect(next.offset).toBe(page.nextOffset);
      expect(next.nextOffset).toBeGreaterThan(next.offset);
      const found = JSON.parse(await recall.execute({ tool_call_id: "search-1", result_index: 0, query: "TARGET" }, options));
      expect(found.content).toBe("TARGET");
      expect(found.truncated).toBe(false);
      expect(JSON.parse(await recall.execute({ tool_call_id: "search-1" }, { ...options, sessionId: "another-session" })).error).toContain("没有此工具结果");
    } finally { await manager.destroy(); await restored.destroy(); removeTempWorkspace(workspace); }
  });

  it("truncates current tool results without summarizing or replaying the live turn", async () => {
    const workspace = createTempWorkspace({ maxContextTokens: 32000, maxTokens: 1000, contextCompressionThreshold: 0.65, autoMemory: { enabled: false } });
    const manager = new PluginManager(workspace);
    try {
      await manager.loadCorePlugins();
      const execute = vi.fn(async () => "资料".repeat(2500));
      context(manager).registerTool({ name: "read_large", description: "read", inputSchema: { type: "object" }, execute });
      const client = new FakeModelClient([
        { text: "", reasoningContent: "first reasoning", toolCalls: [{ type: "tool_use", id: "first", name: "read_large", input: {} }] },
        { text: "", reasoningContent: "", toolCalls: [{ type: "tool_use", id: "second", name: "read_large", input: {} }] },
        messages => {
          expect(validateToolMessageChains(messages)).toBeUndefined();
          const assistants = messages.filter(message => message.role === "assistant");
          expect(assistants.at(-1)?._reasoningContent).toBe("");
          expect(assistants[0]._reasoningContent).toBe("first reasoning");
          expect(JSON.stringify(messages)).toContain("keep this requirement");
          expect(JSON.stringify(messages)).toContain('"id":"first"');
          return { text: "done", toolCalls: [] };
        },
      ]);
      client.complete = vi.fn(async () => { throw new Error("Live turns must not be summarized"); });
      const session = new AgentSession("current", workspace, manager, {}, client);
      const events = await collect(session.chat("keep this requirement"));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(client.complete).not.toHaveBeenCalled();
      expect(loadSessionSummary(workspace, session.id).summarizedThroughSequence).toBe(0);
      expect(readSessionMessages(workspace, session.id).filter(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"))).toHaveLength(2);
    } finally { await manager.destroy(); removeTempWorkspace(workspace); }
  });

  it("reports an unsendable user input as an estimate and releases the session", async () => {
    const workspace = createTempWorkspace({ maxContextTokens: 20000, maxTokens: 1000, autoMemory: { enabled: false } });
    const manager = new PluginManager(workspace);
    try {
      await manager.loadCorePlugins();
      const client = new FakeModelClient([]);
      const session = new AgentSession("too-big", workspace, manager, {}, client);
      const events = await collect(session.chat("输入".repeat(30000)));
      expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("超过模型上下文限制") });
      expect(session.isBusy()).toBe(false);
      expect(client.calls).toHaveLength(0);
      const snapshot = JSON.parse(readFileSync(resolve(sessionDir(workspace, session.id), "context-snapshot.json"), "utf8"));
      expect(snapshot.kind).toBe("estimate");
      expect(snapshot.usage.messages).toBeGreaterThan(20000);
    } finally { await manager.destroy(); removeTempWorkspace(workspace); }
  });
});
