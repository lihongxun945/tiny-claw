import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelClient } from "../../src/model/types.js";
import { createSessionSummaryEngine } from "../../src/session-memory/engine.js";
import { applySummaryDelta, compactSummary, shouldCompactSummary } from "../../src/session-memory/reducer.js";
import {
  compactStoredSessionSummary,
  emptySessionSummary,
  loadSessionSummary,
  saveSessionSummary,
  sessionSummaryArchivePath,
} from "../../src/session-memory/store.js";
import type { SummaryDeltaDraft } from "../../src/session-memory/types.js";
import {
  SummaryDeltaValidationError,
  parseSummaryDeltaDraft,
  validateSummaryDelta,
} from "../../src/session-memory/validation.js";
import type { Message } from "../../src/types.js";
import { estimateTextTokens, estimateTokens } from "../../src/estimate-tokens.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

const limits = {
  maxOperations: 8,
  maxItemChars: 100,
  maxSourcesPerOperation: 3,
};

function messages(): Message[] {
  return [
    { role: "user", content: "目标是完成结构化摘要", _messageId: "msg_1", _sequence: 1, _turnId: "turn_1" },
    { role: "assistant", content: "我会先实现校验器", _messageId: "msg_2", _sequence: 2, _turnId: "turn_1" },
    { role: "user", content: "改为先实现 reducer", _messageId: "msg_3", _sequence: 3, _turnId: "turn_2" },
  ];
}

function addDraft(): SummaryDeltaDraft {
  return {
    baseRevision: 0,
    sourceRange: { fromSequence: 1, throughSequence: 2 },
    operations: [{
      type: "add",
      category: "goals",
      item: { text: "完成结构化摘要", sourceMessageIds: ["msg_1"] },
    }],
  };
}

describe("structured session summary engine", () => {
  it("parses strict JSON and rejects unknown fields", () => {
    expect(parseSummaryDeltaDraft(JSON.stringify(addDraft()))).toEqual(addDraft());
    expect(() => parseSummaryDeltaDraft(JSON.stringify({ ...addDraft(), explanation: "伪造" })))
      .toThrow(SummaryDeltaValidationError);
    expect(() => parseSummaryDeltaDraft("not-json")).toThrow("不是有效 JSON");
  });

  it("materializes trusted sources and deterministic ids", () => {
    const current = emptySessionSummary("session");
    const first = validateSummaryDelta(addDraft(), {
      sessionId: "session",
      current,
      messages: messages(),
      limits,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const replay = validateSummaryDelta(addDraft(), {
      sessionId: "session",
      current,
      messages: messages(),
      limits,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(first).toEqual(replay);
    expect(first.operations[0]).toMatchObject({
      type: "add",
      item: {
        source: { messageIds: ["msg_1"], sequences: [1], turnIds: ["turn_1"] },
      },
    });
    const applied = applySummaryDelta(current, first);
    expect(applySummaryDelta(applied, first)).toBe(applied);
    expect(applied.checkpoint.categories.goals[0].text).toBe("完成结构化摘要");
  });

  it("rejects forged and out-of-range sources without changing the checkpoint", () => {
    const current = emptySessionSummary("session");
    const forged = addDraft();
    forged.operations = [{
      type: "add",
      category: "facts",
      item: { text: "伪造事实", sourceMessageIds: ["msg_missing"] },
    }];
    expect(() => validateSummaryDelta(forged, {
      sessionId: "session",
      current,
      messages: messages(),
      limits,
    })).toThrow("不在 sourceRange 内");
    expect(current).toEqual(emptySessionSummary("session"));
  });
  it("rejects gaps in the declared source range", () => {
    const current = emptySessionSummary("session");
    expect(() => validateSummaryDelta(addDraft(), {
      sessionId: "session",
      current,
      messages: [messages()[0]],
      limits,
    })).toThrow("缺少 sequence 2");
  });

  it("applies supersede and resolve operations without deleting provenance", () => {
    const initial = emptySessionSummary("session");
    const added = applySummaryDelta(initial, validateSummaryDelta(addDraft(), {
      sessionId: "session",
      current: initial,
      messages: messages(),
      limits,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const current = { ...added, revision: 1 };
    const targetId = current.checkpoint.categories.goals[0].id;
    const supersede = validateSummaryDelta({
      baseRevision: 1,
      sourceRange: { fromSequence: 3, throughSequence: 3 },
      operations: [{
        type: "supersede",
        category: "goals",
        targetId,
        replacement: { text: "先完成 reducer", sourceMessageIds: ["msg_3"] },
      }],
    }, {
      sessionId: "session",
      current,
      messages: messages(),
      limits,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const updated = applySummaryDelta(current, supersede);
    expect(updated.checkpoint.categories.goals).toEqual([
      expect.objectContaining({ id: targetId, status: "superseded" }),
      expect.objectContaining({
        status: "active",
        supersedes: [targetId],
        source: expect.objectContaining({ messageIds: ["msg_3"], sequences: [3] }),
      }),
    ]);
    expect(compactSummary(updated, "2026-01-03T00:00:00.000Z").deltas).toEqual([]);
    expect(shouldCompactSummary(updated, { maxDeltas: 2, maxChars: 100000 })).toBe(true);
    expect(shouldCompactSummary(updated, { maxDeltas: 3, maxChars: 100000 })).toBe(false);
  });

  it("extracts a draft through the model boundary and validates it", async () => {
    let prompt = "";
    const client = {
      complete: async (inputMessages: Message[]) => {
        prompt = String(inputMessages[0].content);
        return JSON.stringify(addDraft());
      },
      chat: async () => ({ text: "", toolCalls: [] }),
    } as ModelClient;
    const engine = createSessionSummaryEngine({ limits, maxOutputTokens: 512, maxInputChars: 40000 });
    const delta = await engine.createDelta(client, "session", emptySessionSummary("session"), messages().slice(0, 2));
    expect(prompt).toContain('"messageId":"msg_1"');
    expect(delta.operations).toHaveLength(1);
  });

  it("never sends tool result bodies to the summary model", async () => {
    const source: Message[] = [
      { role: "assistant", _messageId: "m1", _sequence: 1, content: [{ type: "tool_use", id: "call-original", name: "read", input: {} }] },
      { role: "user", _messageId: "m2", _sequence: 2, content: [{ type: "tool_result", tool_use_id: "call-original", content: "SECRET_OUTPUT".repeat(10000) }] },
      { role: "assistant", _messageId: "m3", _sequence: 3, content: "Confirmed conclusion" },
    ];
    const before = structuredClone(source);
    const client = { complete: async (input: Message[]) => {
      const prompt = String(input[0].content);
      expect(prompt).not.toContain("SECRET_OUTPUT");
      expect(prompt).toContain("call-original");
      expect(prompt).toContain("Confirmed conclusion");
      return JSON.stringify({ operations: [] });
    } } as unknown as ModelClient;
    const engine = createSessionSummaryEngine({ limits, maxOutputTokens: 512, maxInputChars: 4000 });
    const delta = await engine.createDelta(client, "session", emptySessionSummary("session"), source);
    expect(delta.throughSequence).toBe(3);
    expect(source).toEqual(before);
  });

  it("bounds summary requests and only covers the prefix actually sent", async () => {
    let requestTokens = 0;
    let calls = 0;
    const client = {
      complete: async (input: Message[], systemPrompt: string) => {
        calls++;
        requestTokens = estimateTokens(input) + estimateTextTokens(systemPrompt);
        const request = JSON.parse(String(input[0].content));
        return JSON.stringify({ baseRevision: request.schema.baseRevision, sourceRange: request.schema.sourceRange, operations: [] });
      },
    } as unknown as ModelClient;
    const source: Message[] = Array.from({ length: 64 }, (_, index) => ({
      role: "user", content: "small message", _messageId: `msg_${index + 1}`, _sequence: index + 1,
    }));
    const options = { limits, maxOutputTokens: 512, maxInputChars: 40000 };
    const current = emptySessionSummary("session");
    await createSessionSummaryEngine(options).createDelta(client, "session", current, source.slice(0, 1));
    const maxContextTokens = requestTokens + 512;
    const delta = await createSessionSummaryEngine({ ...options, maxContextTokens }).createDelta(client, "session", current, source);
    expect(delta.throughSequence).toBe(1);
    expect(requestTokens + 512).toBeLessThanOrEqual(maxContextTokens);
    expect(calls).toBe(2);
    await expect(createSessionSummaryEngine({ ...options, maxContextTokens: 1 }).createDelta(client, "session", current, source)).rejects.toThrow("摘要请求超过输入字符或模型上下文预算");
    expect(calls).toBe(2);
    expect(current.summarizedThroughSequence).toBe(0);
  });

  it("batches complete source messages by serialized input size without clipping their tails", async () => {
    const requests: Array<{ messages: Array<{ content: string }>; schema: { baseRevision: number; sourceRange: { fromSequence: number; throughSequence: number } } }> = [];
    const client = { complete: async (input: Message[], system: string) => {
      expect(String(input[0].content).length + system.length).toBeLessThanOrEqual(7000);
      const request = JSON.parse(String(input[0].content));
      requests.push(request);
      return JSON.stringify({ ...request.schema, operations: [] });
    } } as unknown as ModelClient;
    const engine = createSessionSummaryEngine({ limits, maxOutputTokens: 512, maxInputChars: 7000 });
    const source: Message[] = [1, 2, 3].map((sequence) => ({ role: "user", content: `${"x".repeat(4000)}TAIL-${sequence}`, _messageId: `msg_${sequence}`, _sequence: sequence }));
    let current = emptySessionSummary("session");
    for (let sequence = 1; sequence <= 3; sequence++) {
      const delta = await engine.createDelta(client, "session", current, source.slice(sequence - 1));
      expect(delta.throughSequence).toBe(sequence);
      expect(requests.at(-1)?.messages[0].content).toBe(source[sequence - 1].content);
      current = engine.applyDelta(current, delta);
    }
    const oversized = createSessionSummaryEngine({ limits, maxOutputTokens: 512, maxInputChars: 1000 });
    await expect(oversized.createDelta(client, "session", emptySessionSummary("session"), source)).rejects.toThrow("保留原文和已有摘要");
    expect(requests).toHaveLength(3);
  });

  it("covers complete exchanges without charging tool bodies to the extraction budget", async () => {
    let calls = 0;
    const client = { complete: async (input: Message[]) => {
      calls++;
      const request = JSON.parse(String(input[0].content));
      return JSON.stringify({ ...request.schema, operations: [] });
    } } as unknown as ModelClient;
    const source: Message[] = [
      { role: "user", content: "first", _messageId: "m1", _sequence: 1 },
      { role: "assistant", content: "done", _messageId: "m2", _sequence: 2 },
      { role: "user", content: "second", _messageId: "m3", _sequence: 3 },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }], _messageId: "m4", _sequence: 4 },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(8000) }], _messageId: "m5", _sequence: 5 },
    ];
    const engine = createSessionSummaryEngine({ limits, maxOutputTokens: 512, maxInputChars: 4000 });
    const initial = emptySessionSummary("session");
    const delta = await engine.createDelta(client, "session", initial, source);
    expect(delta.throughSequence).toBe(5);
    const current = engine.applyDelta(initial, delta);
    expect(current.summarizedThroughSequence).toBe(5);
    expect(calls).toBe(1);
  });

  it("archives the pre-compaction state and atomically persists a new checkpoint", async () => {
    const workspacePath = createTempWorkspace();
    try {
      const current = emptySessionSummary("session");
      const applied = applySummaryDelta(current, validateSummaryDelta(addDraft(), {
        sessionId: "session",
        current,
        messages: messages(),
        limits,
        createdAt: "2026-01-01T00:00:00.000Z",
      }));
      await saveSessionSummary(workspacePath, applied);
      const compacted = await compactStoredSessionSummary(
        workspacePath,
        "session",
        0,
        "2026-01-02T00:00:00.000Z",
      );
      expect(compacted.revision).toBe(1);
      expect(compacted.deltas).toEqual([]);
      expect(loadSessionSummary(workspacePath, "session")).toEqual(compacted);
      const archivePath = sessionSummaryArchivePath(workspacePath, "session", 0);
      expect(existsSync(archivePath)).toBe(true);
      expect(JSON.parse(readFileSync(archivePath, "utf-8")).deltas).toHaveLength(1);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
