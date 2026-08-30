import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSessionMessage,
  readSessionMessages,
  readSessionMeta,
  sessionMessagesPath,
} from "../../src/session-store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("session message persistence", () => {
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
