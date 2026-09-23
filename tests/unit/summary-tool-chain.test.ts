import { describe, expect, it } from "vitest";
import type { Message } from "../../src/types.js";
import type { HookContext, ModelCallContext, PluginContext, PluginHooks } from "../../src/plugins/types.js";
import { sanitizeToolMessageChains, selectUncoveredMessages, toolChainMetadata, validateToolMessageChains } from "../../src/message-sanitizer.js";
import { coreSessionSummaryPlugin } from "../../src/plugins/core/session-summary.js";
import { coreProgressPlugin } from "../../src/plugins/core/progress.js";
import { loadSessionSummary, updateSessionSummary } from "../../src/session-memory/store.js";
import { startRun, updateRun } from "../../src/run-store.js";
import { appendSessionMessage, readSessionMessages } from "../../src/session-store.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

const exchange: Message[] = [
  { role: "assistant", _sequence: 2, content: [
    { type: "tool_use", id: "a", name: "read", input: { secret: "PRIVATE_ARGUMENT" } },
    { type: "tool_use", id: "b", name: "read", input: {} },
  ] },
  { role: "user", _sequence: 3, content: [{ type: "tool_result", tool_use_id: "a", content: "PRIVATE_RESULT" }] },
  { role: "user", _sequence: 4, content: [{ type: "tool_result", tool_use_id: "b", content: "ok" }] },
];

describe("summary tool-chain boundaries", () => {
  it("does not resurrect disk calls removed from the current runtime projection", async () => {
    const workspace = createTempWorkspace();
    try {
      await appendSessionMessage(workspace, "projection", { role: "assistant", content: [
        { type: "text", text: "interrupted" }, { type: "tool_use", id: "missing", name: "read", input: {} },
      ] });
      const raw = readSessionMessages(workspace, "projection");
      let hooks!: PluginHooks;
      await coreSessionSummaryPlugin.init({ workspacePath: workspace, registerHooks(value: PluginHooks) { hooks = value; } } as PluginContext);
      const projected = [{ ...raw[0], content: [{ type: "text" as const, text: "interrupted" }] }];
      const result = await hooks.onBeforeModelCall!({ sessionId: "projection", config: loadConfig(workspace) } as HookContext,
        { messages: projected, turnStartIndex: 0, messageTokenBudget: Infinity });
      expect(validateToolMessageChains(result!.messages)).toBeUndefined();
      expect(JSON.stringify(result!.messages)).not.toContain("missing");
      expect(readSessionMessages(workspace, "projection")).toEqual(raw);
    } finally { removeTempWorkspace(workspace); }
  });
  it("describes only missing results while retaining valid pairs and original records", () => {
    const raw = structuredClone(exchange.slice(0, 2));
    const before = structuredClone(raw);
    const projected = sanitizeToolMessageChains(raw, () => "describe");
    expect(validateToolMessageChains(projected)).toBeUndefined();
    expect(JSON.stringify(projected)).toContain("不能推断已执行、成功或失败");
    expect(projected[1]).toEqual(raw[1]);
    expect(projected[0]._sequence).toBe(2);
    expect(raw).toEqual(before);
    expect(sanitizeToolMessageChains(raw, () => "preserve")).toEqual(raw);
    expect(validateToolMessageChains(raw)).toBeDefined();
  });

  it.each(["completed", "running", "waiting_approval", "waiting_user"] as const)("handles an orphan prefix in a %s run without inventing results", async state => {
    const workspace = createTempWorkspace();
    try {
      const sessionId = "orphan";
      startRun(workspace, sessionId, "old", "normal");
      updateRun(workspace, sessionId, "old", { state });
      for (const message of [
        { role: "assistant", _turnId: "old", content: [{ type: "tool_use", id: "orphan", name: "read", input: {} }] },
        { role: "user", content: "a later question ".repeat(2000) },
        ...exchange,
        { role: "assistant", content: "finished" },
        { role: "user", content: "continue" },
      ] as Message[]) await appendSessionMessage(workspace, sessionId, message);
      const messages = readSessionMessages(workspace, sessionId);
      let hooks!: PluginHooks;
      await coreSessionSummaryPlugin.init({ workspacePath: workspace, log() {}, registerHooks(value: PluginHooks) { hooks = value; } } as unknown as PluginContext);
      let calls = 0;
      const client = { complete: async (input: Message[]) => {
        calls++;
        expect(String(input[0].content)).not.toContain("历史工具调用未记录到结果");
        expect(String(input[0].content)).not.toContain("PRIVATE_ARGUMENT");
        return JSON.stringify({ operations: [] });
      } };
      await hooks.onBeforeModelCall!({ sessionId, config: loadConfig(workspace), client } as unknown as HookContext,
        { messages, turnStartIndex: messages.length - 1, messageTokenBudget: 1, hardMessageTokenBudget: 10000 });
      expect(calls).toBe(state === "completed" ? 1 : 0);
      expect(loadSessionSummary(workspace, sessionId).summarizedThroughSequence).toBe(state === "completed" ? messages.length - 1 : 0);
      expect(readSessionMessages(workspace, sessionId)).toEqual(messages);
    } finally { removeTempWorkspace(workspace); }
  });
  it("preserves complete multi-tool exchanges across checkpoint boundaries", () => {
    for (const cutoff of [1, 2, 3]) {
      const result = selectUncoveredMessages(exchange, cutoff, true);
      expect(result).toEqual(exchange);
      expect(validateToolMessageChains(result)).toBeUndefined();
    }
    expect(selectUncoveredMessages(exchange, 4, true)).toEqual([]);
  });
  it("preserves only a real original user request, not a covered result", () => {
    const question: Message = { role: "user", _sequence: 1, content: "question" };
    expect(selectUncoveredMessages([question, ...exchange], 4, true)).toEqual([question]);
    expect(selectUncoveredMessages(exchange.slice(1), 4, true)).toEqual([]);
  });
  it("does not fabricate missing results and diagnostics contain metadata only", () => {
    expect(validateToolMessageChains(selectUncoveredMessages(exchange.slice(0, 1), 1))).toBeDefined();
    const metadata = JSON.stringify(toolChainMetadata(exchange));
    expect(metadata).toContain('"sequence":2');
    expect(metadata).toContain('"id":"a"');
    expect(metadata).not.toContain("PRIVATE");
    expect(metadata).not.toContain("secret");
  });
  it("projects a resumed assistant-first turn with progress reminders without orphaning calls", async () => {
    const workspace = createTempWorkspace({ progress: { toolCalls: 1 } });
    try {
      const sessionId = "resumed";
      for (const message of [{ role: "user", content: "question" } as Message, ...exchange]) {
        await appendSessionMessage(workspace, sessionId, message);
      }
      const messages = readSessionMessages(workspace, sessionId);
      await updateSessionSummary(workspace, sessionId, 0, summary => ({ ...summary, summarizedThroughSequence: 4 }));
      let summaryHooks!: PluginHooks;
      let progressHooks!: PluginHooks;
      await coreSessionSummaryPlugin.init({ workspacePath: workspace, registerHooks(hooks: PluginHooks) { summaryHooks = hooks; } } as PluginContext);
      await coreProgressPlugin.init({ registerHooks(hooks: PluginHooks) { progressHooks = hooks; } } as PluginContext);
      const hook = { sessionId, turnId: "turn", config: loadConfig(workspace) } as HookContext;
      await progressHooks.onAfterTool!(hook, "read", "ok");
      const request = { messages, turnStartIndex: 1, messageTokenBudget: Infinity } as ModelCallContext;
      const reminded = await progressHooks.onBeforeModelCall!(hook, request);
      const projected = await summaryHooks.onBeforeModelCall!(hook, reminded!);
      expect(validateToolMessageChains(projected!.messages)).toBeUndefined();
      expect(projected!.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_use"))).toBe(false);
      expect(projected!.messages.at(-1)?.content).toContain("执行进展提醒");
      expect(readSessionMessages(workspace, sessionId)).toEqual(messages);
    } finally { removeTempWorkspace(workspace); }
  });
});
