import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import {
  deleteSessionState,
  loadSessionState,
  saveSessionState,
  sessionStatePath,
} from "../../src/session-state.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("session-state persistence", () => {
  it("saves and loads session summary state with encoded session ids", () => {
    const workspacePath = createTempWorkspace();
    const sessionId = "feishu:oc/chat?x#y";
    try {
      const saved = saveSessionState(workspacePath, {
        sessionId,
        summary: "用户希望持久化会话记忆",
        pendingMessages: [{ role: "user", content: "hello", _timestamp: 1 }],
        turnsSinceSummary: 2,
      });

      const path = sessionStatePath(workspacePath, sessionId);
      expect(path).not.toContain(sessionId);
      expect(path).toContain("/sessions/");
      expect(path.endsWith("/state.json")).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(loadSessionState(workspacePath, sessionId)).toMatchObject({
        version: saved.version,
        sessionId,
        summary: "用户希望持久化会话记忆",
        pendingMessages: [{ role: "user", content: "hello", _timestamp: 1 }],
        turnsSinceSummary: 2,
      });
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("falls back to empty state for corrupt files and deletes state files", () => {
    const workspacePath = createTempWorkspace();
    const sessionId = "broken";
    try {
      saveSessionState(workspacePath, {
        sessionId,
        summary: "old",
        pendingMessages: [],
        turnsSinceSummary: 1,
      });
      writeFileSync(sessionStatePath(workspacePath, sessionId), "{bad json", "utf-8");

      expect(loadSessionState(workspacePath, sessionId)).toMatchObject({
        sessionId,
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
      });
      expect(deleteSessionState(workspacePath, sessionId)).toBe(true);
      expect(deleteSessionState(workspacePath, sessionId)).toBe(false);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
