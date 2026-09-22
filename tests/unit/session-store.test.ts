import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSessionMessage,
  readSessionMessages,
  readSessionMeta,
  sessionMessagesPath,
  updateSessionModelId,
} from "../../src/session-store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("session message persistence", () => {
  it("preserves explicit runtime notice provenance without classifying legacy text", async () => {
    const workspacePath = createTempWorkspace();
    try {
      await appendSessionMessage(workspacePath, "notices", { role: "assistant", content: "任务已停止", _source: "runtime_notice" });
      await appendSessionMessage(workspacePath, "notices", { role: "assistant", content: "任务已停止" });
      const messages = readSessionMessages(workspacePath, "notices");
      expect(messages[0]._source).toBe("runtime_notice");
      expect(messages[1]).not.toHaveProperty("_source");
    } finally { removeTempWorkspace(workspacePath); }
  });

  it.each(["protocol metadata", ""])("preserves reasoning metadata through disk reads (%j)", async reasoning => {
    const workspacePath = createTempWorkspace();
    try {
      const persisted = await appendSessionMessage(workspacePath, "reasoning", {
        role: "assistant", content: [{ type: "tool_use", id: "call", name: "test", input: {} }],
        _reasoningContent: reasoning,
      });
      expect(readSessionMessages(workspacePath, "reasoning")).toEqual([persisted]);
      expect(readSessionMessages(workspacePath, "reasoning")[0]._reasoningContent).toBe(reasoning);
    } finally { removeTempWorkspace(workspacePath); }
  });

  it("ignores malformed reasoning metadata and preserves legacy records", () => {
    const workspacePath = createTempWorkspace();
    try {
      const path = sessionMessagesPath(workspacePath, "reasoning");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, [undefined, null, 123, {}].map(value => JSON.stringify({
        role: "assistant", content: "answer", _reasoningContent: value,
      })).join("\n"));
      const messages = readSessionMessages(workspacePath, "reasoning");
      expect(messages).toHaveLength(4);
      expect(messages.every(message => message._reasoningContent === undefined)).toBe(true);
    } finally { removeTempWorkspace(workspacePath); }
  });

  it("assigns stable IDs and monotonic sequences under concurrent appends", async () => {
    const workspacePath = createTempWorkspace();
    try {
      const persisted = await Promise.all([
        appendSessionMessage(workspacePath, "session", { role: "user", content: "one" }),
        appendSessionMessage(workspacePath, "session", { role: "assistant", content: "two" }),
        appendSessionMessage(workspacePath, "session", { role: "user", content: "three" }),
      ]);

      expect(persisted.map((message) => message._sequence)).toEqual([1, 2, 3]);
      expect(new Set(persisted.map((message) => message._messageId)).size).toBe(3);
      expect(persisted.every((message) => message._messageId?.startsWith("msg_"))).toBe(true);
      expect(readSessionMeta(workspacePath, "session")?.lastMessageSequence).toBe(3);
      expect(readSessionMessages(workspacePath, "session")).toEqual(persisted);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("derives deterministic legacy IDs and continues the legacy sequence", async () => {
    const workspacePath = createTempWorkspace();
    try {
      const path = sessionMessagesPath(workspacePath, "legacy");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, [
        JSON.stringify({ role: "user", content: "old one" }),
        "{broken",
        JSON.stringify({ role: "assistant", content: "old two" }),
        "",
      ].join("\n"), "utf-8");

      const firstRead = readSessionMessages(workspacePath, "legacy");
      const secondRead = readSessionMessages(workspacePath, "legacy");
      expect(firstRead.map((message) => message._sequence)).toEqual([1, 2]);
      expect(firstRead.map((message) => message._messageId)).toEqual(
        secondRead.map((message) => message._messageId),
      );
      expect(firstRead.every((message) => message._messageId?.startsWith("legacy_"))).toBe(true);

      const appended = await appendSessionMessage(workspacePath, "legacy", { role: "user", content: "new" });
      expect(appended._sequence).toBe(3);
      expect(readSessionMeta(workspacePath, "legacy")?.lastMessageSequence).toBe(3);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});

describe("session model persistence", () => {
  it("persists currentModelId and keeps it through message appends", async () => {
    const workspacePath = createTempWorkspace();
    try {
      await appendSessionMessage(workspacePath, "models", { role: "user", content: "hi" });
      expect(readSessionMeta(workspacePath, "models")?.currentModelId).toBeUndefined();

      const updated = updateSessionModelId(workspacePath, "models", "fast");
      expect(updated.currentModelId).toBe("fast");
      expect(readSessionMeta(workspacePath, "models")?.currentModelId).toBe("fast");

      await appendSessionMessage(workspacePath, "models", { role: "assistant", content: "ok" });
      expect(readSessionMeta(workspacePath, "models")?.currentModelId).toBe("fast");
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("throws when updating the model of a missing session", () => {
    const workspacePath = createTempWorkspace();
    try {
      expect(() => updateSessionModelId(workspacePath, "nope", "fast")).toThrow("会话不存在");
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
