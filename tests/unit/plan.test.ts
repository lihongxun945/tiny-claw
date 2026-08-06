import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { createSessionMeta } from "../../src/session-store.js";
import {
  completeFinalPlanStep,
  createSessionPlan,
  readSessionPlan,
  updateSessionPlanStep,
} from "../../src/plan-store.js";
import { createPlanCreateTool } from "../../src/tools/plan.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTempWorkspace } from "../helpers/temp-workspace.js";

describe("session plans", () => {
  const turnId = "11111111-1111-4111-8111-111111111111";
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  function setup() {
    const workspace = createTempWorkspace({ plan: { enabled: true, maxSteps: 4 } });
    workspaces.push(workspace);
    createSessionMeta(workspace, "plan-session", { mode: "chat" });
    return workspace;
  }

  it("persists ordered progress and completes a plan", () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["分析", "实现"]);
    expect(updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress").currentStepId).toBe("step-1");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "completed", "完成分析");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-2", "in_progress");
    const completed = updateSessionPlanStep(workspace, "plan-session", turnId, "step-2", "completed");
    expect(completed.status).toBe("completed");
    expect(readSessionPlan(workspace, "plan-session", turnId)).toEqual(completed);
  });

  it("rejects skipped order and parallel in-progress steps", () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["第一步", "第二步"]);
    expect(() => updateSessionPlanStep(workspace, "plan-session", turnId, "step-2", "in_progress")).toThrow("按顺序");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
    expect(() => updateSessionPlanStep(workspace, "plan-session", turnId, "step-2", "in_progress")).toThrow();
  });

  it("completes the final active step when the agent returns its final response", () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["分析", "输出结论"]);
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "completed");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-2", "in_progress");

    const completed = completeFinalPlanStep(workspace, "plan-session", turnId);

    expect(completed?.status).toBe("completed");
    expect(completed?.steps[1]).toEqual(expect.objectContaining({
      status: "completed",
      summary: "已完成并输出最终结果",
    }));
  });

  it("does not complete an active step while later steps are still pending", () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["分析", "实现"]);
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");

    const unchanged = completeFinalPlanStep(workspace, "plan-session", turnId);

    expect(unchanged?.status).toBe("executing");
    expect(unchanged?.steps.map((step) => step.status)).toEqual(["in_progress", "pending"]);
  });

  it("only exposes plan tools in plan execution mode", () => {
    const workspace = setup();
    const registry = new ToolRegistry();
    registry.register(createPlanCreateTool(workspace, () => ({ plan: { maxSteps: 4 } }) as never));
    expect(registry.getDefinitions({ mode: "chat" }, "normal")).toEqual([]);
    expect(registry.getDefinitions({ mode: "chat" }, "plan")).toEqual([expect.objectContaining({ name: "plan_create" })]);
  });
});
