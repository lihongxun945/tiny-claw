import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { createSessionMeta } from "../../src/session-store.js";
import {
  completeFinalPlanStep,
  createSessionPlan,
  findActiveSessionPlan,
  readSessionPlan,
  revisePendingPlanSteps,
  updateSessionPlanStep,
} from "../../src/plan-store.js";
import { createPlanCreateTool, createPlanPauseTool, createPlanReviseTool } from "../../src/tools/plan.js";
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

  it("persists a user pause and resolves it from a later turn", async () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["设计方案", "实现"]);
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
    const pauseTool = createPlanPauseTool(workspace);
    const result = JSON.parse(await pauseTool.execute(
      { summary: "方案已给出，等待用户确认" },
      { executionMode: "plan", sessionId: "plan-session", turnId, config: {} as never },
    ));

    expect(result.plan.steps[0].status).toBe("waiting_user");
    expect(findActiveSessionPlan(workspace, "plan-session", "22222222-2222-4222-8222-222222222222")?.turnId).toBe(turnId);
  });

  it("replaces only pending plan steps and increments the revision", () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["调研", "制定方案", "实施"]);
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "completed", "调研完成");

    const revised = revisePendingPlanSteps(workspace, "plan-session", turnId, ["修改状态机", "增加测试"], 4);

    expect(revised.revision).toBe(1);
    expect(revised.steps).toEqual([
      expect.objectContaining({ id: "step-1", title: "调研", status: "completed", summary: "调研完成" }),
      { id: "step-4", title: "修改状态机", status: "pending" },
      { id: "step-5", title: "增加测试", status: "pending" },
    ]);
  });

  it("rejects revising a plan without pending steps or beyond the configured limit", async () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["调研", "实施"]);
    expect(revisePendingPlanSteps(workspace, "plan-session", turnId, ["一", "二", "三", "四"], 4)).toBeDefined();

    const secondTurn = "22222222-2222-4222-8222-222222222222";
    createSessionPlan(workspace, "plan-session", secondTurn, ["调研", "实施"]);
    const reviseTool = createPlanReviseTool(workspace, () => ({ plan: { maxSteps: 2 } }) as never);
    const result = JSON.parse(await reviseTool.execute(
      { steps: ["一", "二", "三"] },
      { executionMode: "plan", sessionId: "plan-session", turnId: secondTurn, config: { plan: { maxSteps: 2 } } as never },
    ));
    expect(result.error).toContain("2 到 2");
  });
});
