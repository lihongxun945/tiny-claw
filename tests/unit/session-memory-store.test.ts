import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SessionSummaryRevisionConflictError,
  emptySessionSummary,
  loadSessionSummary,
  saveSessionSummary,
  sessionSummaryPath,
  updateSessionSummary,
} from "../../src/session-memory/store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("structured session summary store", () => {
  it("returns an empty summary and persists atomic revisions", async () => {
    const workspacePath = createTempWorkspace();
    try {
      expect(loadSessionSummary(workspacePath, "session")).toEqual(emptySessionSummary("session"));
      const initial = await saveSessionSummary(workspacePath, emptySessionSummary("session"));
      const updated = await updateSessionSummary(workspacePath, "session", initial.revision, (current) => ({
        ...current,
        summarizedThroughSequence: 5,
      }));
      expect(updated.revision).toBe(1);
      expect(updated.summarizedThroughSequence).toBe(5);
      expect(loadSessionSummary(workspacePath, "session")).toEqual(updated);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("rejects stale revisions without overwriting the latest state", async () => {
    const workspacePath = createTempWorkspace();
    try {
      await saveSessionSummary(workspacePath, emptySessionSummary("session"));
      await updateSessionSummary(workspacePath, "session", 0, (current) => ({ ...current, summarizedThroughSequence: 1 }));
      await expect(updateSessionSummary(workspacePath, "session", 0, (current) => current))
        .rejects.toBeInstanceOf(SessionSummaryRevisionConflictError);
      expect(loadSessionSummary(workspacePath, "session").summarizedThroughSequence).toBe(1);
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });

  it("reports corrupt persisted summaries instead of silently replacing them", () => {
    const workspacePath = createTempWorkspace();
    try {
      const path = sessionSummaryPath(workspacePath, "session");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{broken", "utf-8");
      expect(() => loadSessionSummary(workspacePath, "session")).toThrow("无法读取 Session 结构化摘要");
    } finally {
      removeTempWorkspace(workspacePath);
    }
  });
});
