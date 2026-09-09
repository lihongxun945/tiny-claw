import { afterEach, expect, it, vi } from "vitest";
import { startRun, updateRun, readRun } from "../../src/run-store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

afterEach(() => vi.useRealTimers());

it("preserves total elapsed time across approval and freezes terminal time", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const workspace = createTempWorkspace();
  try {
    const run = startRun(workspace, "session", "turn", "normal");
    vi.setSystemTime(Date.now() + 1000);
    updateRun(workspace, "session", "turn", { state: "waiting_approval", approvalId: "approval" });
    vi.setSystemTime(Date.now() + 60000);
    const resumed = startRun(workspace, "session", "turn", "normal", "approval");
    expect(resumed.startedAt).toBe(run.startedAt);
    expect(resumed.completedAt).toBeUndefined();
    vi.setSystemTime(Date.now() + 1000);
    const ended = updateRun(workspace, "session", "turn", { state: "completed" })!;
    expect(ended.completedAt! - ended.startedAt!).toBe(62000);
    vi.setSystemTime(Date.now() + 60000);
    updateRun(workspace, "session", "turn", { reason: "saved" });
    expect(readRun(workspace, "session", "turn")?.completedAt).toBe(ended.completedAt);
    expect(startRun(workspace, "session", "next", "normal").startedAt).toBeGreaterThan(ended.completedAt!);
  } finally { removeTempWorkspace(workspace); }
});
