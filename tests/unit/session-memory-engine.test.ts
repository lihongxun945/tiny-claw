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
    const engine = createSessionSummaryEngine({ limits, maxOutputTokens: 512, maxInputChars: 1000 });
    const delta = await engine.createDelta(client, "session", emptySessionSummary("session"), messages().slice(0, 2));
    expect(prompt).toContain('"messageId":"msg_1"');
    expect(delta.operations).toHaveLength(1);
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
