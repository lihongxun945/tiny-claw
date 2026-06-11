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
        autoMemory: {
          pendingTurns: [{ user: "记住偏好", assistant: "已记住", at: "2026-06-11T00:00:00.000Z" }],
          turnsSinceAnalysis: 1,
        },
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
        autoMemory: {
          pendingTurns: [{ user: "记住偏好", assistant: "已记住", at: "2026-06-11T00:00:00.000Z" }],
          turnsSinceAnalysis: 1,
        },
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

  it("preserves auto-memory state when saving summary-only state", () => {
    const workspacePath = createTempWorkspace();
    const sessionId = "merge-state";
    try {
      saveSessionState(workspacePath, {
        sessionId,
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{ user: "新增问题", assistant: "最终回答", at: "2026-06-11T00:00:00.000Z" }],
          turnsSinceAnalysis: 1,
        },
      });

      saveSessionState(workspacePath, {
        sessionId,
        summary: "会话摘要",
        pendingMessages: [{ role: "assistant", content: "摘要后待处理", _timestamp: 2 }],
        turnsSinceSummary: 3,
      });

      expect(loadSessionState(workspacePath, sessionId)).toMatchObject({
        summary: "会话摘要",
        turnsSinceSummary: 3,
        autoMemory: {
          pendingTurns: [{ user: "新增问题", assistant: "最终回答", at: "2026-06-11T00:00:00.000Z" }],
          turnsSinceAnalysis: 1,
        },
      });
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
