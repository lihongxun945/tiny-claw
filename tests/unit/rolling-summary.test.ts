import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { validateConfig as validate, loadConfig } from "../../src/config.js";
import { estimateTokens } from "../../src/estimate-tokens.js";
import { batchFromDelta, selectBatchIds, renderRollingSummary, migrateLegacySummary } from "../../src/session-memory/rolling.js";
import { withinSummaryDeadline } from "../../src/session-memory/deadline.js";
import { emptySessionSummary, loadSessionSummary, updateSessionSummary, sessionSummaryArchivePath } from "../../src/session-memory/store.js";
import { coreSessionSummaryPlugin } from "../../src/plugins/core/session-summary.js";
import { coreToolContextPlugin } from "../../src/plugins/core/tool-context.js";
import { appendSessionMessage, readSessionMessages } from "../../src/session-store.js";
import { validateToolMessageChains } from "../../src/message-sanitizer.js";
import { buildModelContext } from "../../src/model-context.js";
import { estimateTextTokens } from "../../src/estimate-tokens.js";
import type { PluginContext, PluginHooks, HookContext, ModelCallContext } from "../../src/plugins/types.js";
import type { Config, Message } from "../../src/types.js";
import type { SummaryDelta } from "../../src/session-memory/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

function validateConfig(raw: Record<string, unknown>) {
  validate({ apiUrl: "https://example.com", apiKey: "test", model: "test", ...raw });
}

async function hooks(workspacePath: string) {
  let registered!: PluginHooks;
  await coreSessionSummaryPlugin.init({ workspacePath, log() {}, registerHooks(value: PluginHooks) { registered = value; } } as unknown as PluginContext);
  return registered;
}

describe("rolling context compression", () => {
  it.each([[0.8, 0.8], [0.2, 0.8], [1, 0.2], [0.8, 0], [NaN, 0.2], [0.8, Infinity]])("rejects invalid watermarks %s/%s", (trigger, target) => {
    expect(() => validateConfig({ contextCompressionThreshold: trigger, contextCompressionTargetRatio: target })).toThrow();
  });

  it("validates partial updates against defaults and summary allocation", () => {
    expect(() => validateConfig({ contextCompressionThreshold: 0.8, contextCompressionTargetRatio: 0.2 })).not.toThrow();
    expect(() => validateConfig({ contextCompressionThreshold: 0.15 })).toThrow("目标阈值");
    expect(() => validateConfig({ contextCompressionTargetRatio: 0.05 })).toThrow("摘要预算");
    expect(() => validateConfig({ sessionSummary: { recentBatchCount: 0 } })).toThrow();
    expect(() => validateConfig({ sessionSummary: { maxBudgetRatio: 0.3 } })).toThrow("摘要预算");
  });

  it("selects immutable latest batches without dropping active constraints", () => {
    const summary = emptySessionSummary("s");
    summary.batches = Array.from({ length: 9 }, (_, index) => ({ id: String(index), fromSequence: index * 2 + 1,
      throughSequence: index * 2 + 2, text: `history-${index}`, createdAt: "fixed" }));
    summary.checkpoint.categories.constraints.push({ id: "c", text: "Never alter database", status: "active",
      source: { messageIds: ["m"], sequences: [1], turnIds: ["t"] }, createdAt: "fixed" });
    const before = JSON.stringify(summary.batches);
    const ids = selectBatchIds(summary, { sessionSummary: { recentBatchCount: 2 } } as Config, 10000);
    expect(ids).toEqual(["7", "8"]);
    summary.projection = { selectedBatchIds: ids, toolResultLimits: {}, budget: 10000 };
    expect(renderRollingSummary(summary)).toContain("Never alter database");
    expect(renderRollingSummary(summary)).not.toContain("history-0");
    expect(JSON.stringify(summary.batches)).toBe(before);
    expect(selectBatchIds(summary, {} as Config, 1)).toEqual([]);
  });

  it("materializes resolved targets so batches have no delta dependencies", () => {
    const summary = emptySessionSummary("s");
    const source = { messageIds: ["m"], sequences: [1], turnIds: ["t"] };
    summary.checkpoint.categories.pending.push({ id: "p", text: "Fix build", status: "active", source, createdAt: "now" });
    const delta: SummaryDelta = { id: "d", fromSequence: 2, throughSequence: 4, baseRevision: 0, createdAt: "now",
      operations: [{ type: "resolve", category: "pending", targetId: "p", source }] };
    expect(batchFromDelta(summary, delta).text).toBe("已解决: Fix build");
  });

  it("shrinks a current exchange with no eligible history and restores the same projection after restart", async () => {
    const workspace = createTempWorkspace();
    try {
      for (const message of [
        { role: "user", content: "inspect" },
        { role: "assistant", content: [{ type: "tool_use", id: "large", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "large", content: "大型工具输出".repeat(6000) }] },
      ] as Message[]) await appendSessionMessage(workspace, "s", message);
      const messages = readSessionMessages(workspace, "s");
      const config = loadConfig(workspace);
      const request = { messages, turnStartIndex: 0, messageTokenBudget: 6400, hardMessageTokenBudget: 8000 } as ModelCallContext;
      const context = { sessionId: "s", config } as HookContext;
      const first = (await (await hooks(workspace)).onBeforeModelCall!(context, request))!;
      expect(estimateTokens(first.messages)).toBeLessThanOrEqual(1600);
      expect(validateToolMessageChains(first.messages)).toBeUndefined();
      expect(JSON.stringify(first.messages)).toContain("contentRef");
      expect(readSessionMessages(workspace, "s")).toEqual(messages);
      expect(loadSessionSummary(workspace, "s").projection?.toolResultLimits.large).toBeDefined();
      const restored = (await (await hooks(workspace)).onBeforeModelCall!(context, request))!;
      expect(restored.messages).toEqual(first.messages);
    } finally { removeTempWorkspace(workspace); }
  });

  it("does not summarize earlier tool exchanges in a live turn", async () => {
    const workspace = createTempWorkspace();
    try {
      for (const message of [
        { role: "user", content: "live request" },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "data".repeat(8000) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "b", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "more data".repeat(8000) }] },
      ] as Message[]) await appendSessionMessage(workspace, "live", { ...message, _turnId: "turn" });
      const messages = readSessionMessages(workspace, "live");
      let calls = 0;
      const client = { complete: async () => { calls++; return '{"operations":[]}'; } };
      const context = { sessionId: "live", turnId: "turn", config: loadConfig(workspace), client } as unknown as HookContext;
      // Resume may begin after the original user request, without a Run record.
      const result = await (await hooks(workspace)).onBeforeModelCall!(context,
        { messages, turnStartIndex: 1, messageTokenBudget: 6400, hardMessageTokenBudget: 8000 });
      expect(calls).toBe(0);
      expect(loadSessionSummary(workspace, "live").summarizedThroughSequence).toBe(0);
      expect(validateToolMessageChains(result!.messages)).toBeUndefined();
      expect(readSessionMessages(workspace, "live")).toEqual(messages);
    } finally { removeTempWorkspace(workspace); }
  });

  it("budgets complete dynamic wrappers instead of only summary text (105-token regression)", async () => {
    let toolHooks!: PluginHooks;
    await coreToolContextPlugin.init({ registerRoute() {}, extendPrompt() {}, registerHooks(value: PluginHooks) { toolHooks = value; } } as unknown as PluginContext);
    const workspace = createTempWorkspace();
    try {
      const baseSystemPrompt = "stable prompt";
      const request: ModelCallContext = { messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "data".repeat(10000) }] },
      ], turnStartIndex: 0, messageTokenBudget: 900, hardMessageTokenBudget: 1000, baseSystemPrompt,
      derivedContext: "history", systemPromptSuffix: "dynamic".repeat(15) };
      const result = (await toolHooks.onBeforeModelCall!({ config: loadConfig(workspace) } as HookContext, request))!;
      const final = buildModelContext(baseSystemPrompt, result.messages, result.derivedContext, result.systemPromptSuffix);
      expect(estimateTokens(final.messages) + estimateTextTokens(final.systemPrompt) - estimateTextTokens(baseSystemPrompt)).toBeLessThanOrEqual(1000);
      expect(validateToolMessageChains(final.messages)).toBeUndefined();
    } finally { removeTempWorkspace(workspace); }
  });

  it("converts legacy state without a model call and archives the old checkpoint", async () => {
    const workspace = createTempWorkspace();
    try {
      for (const message of [{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" },
        { role: "user", content: "new".repeat(600) }] as Message[]) await appendSessionMessage(workspace, "s", message);
      await updateSessionSummary(workspace, "s", 0, summary => ({ ...summary, summarizedThroughSequence: 2,
        checkpoint: { ...summary.checkpoint, categories: { ...summary.checkpoint.categories, facts: [{
          id: "fact", text: "existing fact", status: "active", createdAt: "fixed",
          source: { messageIds: ["old"], sequences: [1], turnIds: [] },
        }] } } }));
      const messages = readSessionMessages(workspace, "s");
      let calls = 0;
      const client = { complete: async () => { calls++; throw new Error("Migration must not call a model"); } };
      await (await hooks(workspace)).onBeforeModelCall!({ config: loadConfig(workspace), sessionId: "s", client } as unknown as HookContext,
        { messages, turnStartIndex: 2, messageTokenBudget: 100, hardMessageTokenBudget: 1000 });
      expect(loadSessionSummary(workspace, "s").batches).toHaveLength(1);
      expect(calls).toBe(0);
      expect(loadSessionSummary(workspace, "s").summarizedThroughSequence).toBe(2);
      expect(existsSync(sessionSummaryArchivePath(workspace, "s", 1))).toBe(true);
      expect(readSessionMessages(workspace, "s")).toEqual(messages);
    } finally { removeTempWorkspace(workspace); }
  });

  it.each([1, 20])("honors batch limit %s and resumes from committed coverage", async (limit) => {
    const workspace = createTempWorkspace({ sessionSummary: { maxInputChars: 4000, recentBatchCount: 2, maxBatchesPerCompression: limit } });
    try {
      for (let i = 0; i < 12; i++) {
        await appendSessionMessage(workspace, "s", { role: "user", content: `question ${i}: ${"history ".repeat(200)}` });
        await appendSessionMessage(workspace, "s", { role: "assistant", content: "done" });
      }
      await appendSessionMessage(workspace, "s", { role: "user", content: "continue" });
      const messages = readSessionMessages(workspace, "s");
      let calls = 0;
      const starts: number[] = [];
      const client = { complete: async (input: Message[]) => {
        calls++;
        const payload = JSON.parse(String(input[0].content));
        starts.push(payload.messages[0].sequence);
        return JSON.stringify({ operations: [{ type: "add", category: "facts",
          item: { text: `Independent fact ${calls}`, sourceMessageIds: [payload.messages[0].messageId] } }] });
      } };
      const result = (await (await hooks(workspace)).onBeforeModelCall!({ config: loadConfig(workspace), sessionId: "s", client } as unknown as HookContext,
        { messages, turnStartIndex: 24, messageTokenBudget: 4000, hardMessageTokenBudget: 5000 }))!;
      if (limit === 1) expect(calls).toBe(1);
      else expect(calls).toBeGreaterThan(1);
      const rendered = buildModelContext("", result.messages, result.derivedContext);
      if (limit > 1) expect(estimateTokens(rendered.messages) + estimateTextTokens(rendered.systemPrompt)).toBeLessThanOrEqual(1000);
      const saved = loadSessionSummary(workspace, "s");
      expect(saved.batches!.length).toBe(calls);
      expect(saved.projection!.selectedBatchIds.length).toBeLessThanOrEqual(2);
      expect(saved.checkpoint.categories.facts).toEqual([]);
      expect(readSessionMessages(workspace, "s")).toEqual(messages);
      if (limit === 1) {
        await (await hooks(workspace)).onBeforeModelCall!({ config: loadConfig(workspace), sessionId: "s", client } as unknown as HookContext,
          { messages, turnStartIndex: 24, messageTokenBudget: 1, hardMessageTokenBudget: 5000 });
        expect(calls).toBe(2);
        expect(starts[1]).toBeGreaterThan(saved.summarizedThroughSequence);
      }
    } finally { removeTempWorkspace(workspace); }
  });

  it("does not replace legacy state when migration is cancelled", async () => {
    const workspace = createTempWorkspace();
    try {
      await appendSessionMessage(workspace, "s", { role: "user", content: "old" });
      await appendSessionMessage(workspace, "s", { role: "user", content: "new".repeat(600) });
      await updateSessionSummary(workspace, "s", 0, summary => ({ ...summary, summarizedThroughSequence: 1 }));
      const before = loadSessionSummary(workspace, "s");
      const controller = new AbortController();
      controller.abort();
      const client = { complete: async () => { throw new Error("must not call model"); } };
      await expect((await hooks(workspace)).onBeforeModelCall!({ config: loadConfig(workspace), sessionId: "s", client, signal: controller.signal } as unknown as HookContext,
        { messages: readSessionMessages(workspace, "s"), turnStartIndex: 1, messageTokenBudget: 100, hardMessageTokenBudget: 1000 })).rejects.toThrow();
      expect(loadSessionSummary(workspace, "s")).toEqual(before);
    } finally { removeTempWorkspace(workspace); }
  });

  it("keeps a large legacy watermark and live constraints without reading original messages", () => {
    const old = emptySessionSummary("s");
    old.summarizedThroughSequence = 1545;
    old.checkpoint.categories.constraints.push({ id: "c", text: "keep files", status: "active", createdAt: "fixed",
      source: { messageIds: ["m"], sequences: [1], turnIds: [] } });
    const converted = migrateLegacySummary(old);
    expect(converted.summarizedThroughSequence).toBe(1545);
    expect(converted.checkpoint.categories.constraints).toEqual(old.checkpoint.categories.constraints);
    expect(migrateLegacySummary(converted)).toBe(converted);
    expect(old.batches).toBeUndefined();
  });

  it("enforces a deadline even when a model ignores AbortSignal", async () => {
    let signal!: AbortSignal;
    await expect(withinSummaryDeadline(s => { signal = s; return new Promise(() => {}); }, 5)).rejects.toThrow("总耗时上限");
    expect(signal.aborted).toBe(true);
    const controller = new AbortController();
    const pending = withinSummaryDeadline(() => new Promise(() => {}), 1000, controller.signal);
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow("user cancelled");
  });
});
