import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { createSessionMeta } from "../../src/session-store.js";
import {
  completeFinalPlanStep,
  createSessionPlan,
  findActiveSessionPlan,
  readSessionPlan,
  resumeSessionPlan,
  revisePendingPlanSteps,
  updateSessionPlanStep,
  type SessionPlan,
} from "../../src/plan-store.js";
import { createPlanCreateTool, createPlanPauseTool, createPlanReviseTool } from "../../src/tools/plan.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTempWorkspace } from "../helpers/temp-workspace.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { loadConfig } from "../../src/config.js";
import { MessageHistory } from "../../src/history.js";
import { FakeModelClient } from "../helpers/fake-model-client.js";

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

  it("requires and persists a goal across revisions and resume", async () => {
    const workspace = setup();
    const tool = createPlanCreateTool(workspace, () => loadConfig(workspace));
    const context = { executionMode: "plan" as const, sessionId: "plan-session", turnId };
    for (const goal of [undefined, "   ", 42]) {
      expect(JSON.parse(await tool.execute({ goal, steps: ["分析", "实现"] }, context)).error).toContain("goal");
      expect(readSessionPlan(workspace, context.sessionId, turnId)).toBeUndefined();
    }
    const { plan } = JSON.parse(await tool.execute({ goal: "  刷新后持续接收回复  ", steps: ["分析", "实现"] }, context));
    expect(readSessionPlan(workspace, context.sessionId, turnId)?.goal).toBe("刷新后持续接收回复");
    expect(revisePendingPlanSteps(workspace, context.sessionId, turnId, ["修复", "验证"], 4).goal).toBe(plan.goal);
    updateSessionPlanStep(workspace, context.sessionId, turnId, "step-3", "in_progress");
    updateSessionPlanStep(workspace, context.sessionId, turnId, "step-3", "waiting_user");
    expect(resumeSessionPlan(workspace, context.sessionId, "next-turn", plan.id).goal).toBe(plan.goal);
    expect(findActiveSessionPlan(workspace, context.sessionId, "next-turn")?.goal).toBe(plan.goal);
  });

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

  it("allows read-only discovery before planning and gates side effects until a step starts", async () => {
    const workspace = setup();
    const manager = new PluginManager(workspace);
    await manager.loadCorePlugins();
    manager.setRuntimeDeps(loadConfig(workspace), new FakeModelClient([]), new MessageHistory(), "plan-session");
    await manager.beginTurn("plan-session", turnId, "plan");
    const names = () => manager.getToolDefinitions({ mode: "chat" }, "plan", "plan-session").map((tool) => tool.name);

    try {
      expect(names()).toEqual(expect.arrayContaining(["plan_create", "file_read", "web_search", "memory_search", "profile_read", "skill_list"]));
      for (const name of ["file_write", "file_edit", "bash", "skill_use", "sub_agent_run"]) expect(names()).not.toContain(name);
      expect(await manager.callOnBeforeTool("file_read", {}, 1, "plan-session")).toEqual({});
      expect(await manager.callOnBeforeTool("file_write", {}, 1, "plan-session")).toEqual({
        abort: "计划模式执行写入或有副作用的工具前必须先调用 plan_create",
      });

      createSessionPlan(workspace, "plan-session", turnId, ["修改实现", "运行测试"]);
      expect(names()).toEqual(expect.arrayContaining(["plan_update", "plan_revise", "file_read", "memory_search"]));
      for (const name of ["plan_create", "file_write", "bash", "skill_use"]) expect(names()).not.toContain(name);
      expect(await manager.callOnBeforeTool("file_read", {}, 1, "plan-session")).toEqual({});
      expect((await manager.callOnBeforeTool("file_write", {}, 1, "plan-session")).abort).toContain("plan_update");

      updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
      expect(names()).toEqual(expect.arrayContaining(["file_read", "file_write", "bash", "skill_use", "plan_update"]));
      expect(names()).not.toContain("plan_create");
      expect(await manager.callOnBeforeTool("file_write", {}, 1, "plan-session")).toEqual({});
    } finally {
      await manager.destroy();
    }
  });

  it("only resolves a paused plan after an explicit persisted resume", async () => {
    const workspace = setup();
    createSessionPlan(workspace, "plan-session", turnId, ["设计方案", "实现"]);
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
    const pauseTool = createPlanPauseTool(workspace);
    const result = JSON.parse(await pauseTool.execute(
      { summary: "方案已给出，等待用户确认" },
      { executionMode: "plan", sessionId: "plan-session", turnId, config: {} as never },
    ));

    expect(result.plan.steps[0].status).toBe("waiting_user");
    const nextTurn = "22222222-2222-4222-8222-222222222222";
    expect(findActiveSessionPlan(workspace, "plan-session", nextTurn)).toBeUndefined();
    resumeSessionPlan(workspace, "plan-session", nextTurn, result.plan.id);
    expect(findActiveSessionPlan(workspace, "plan-session", nextTurn)?.turnId).toBe(turnId);
    expect(readSessionPlan(workspace, "plan-session", turnId)?.relatedTurnIds).toEqual([nextTurn]);
    expect(() => resumeSessionPlan(workspace, "plan-session", nextTurn, result.plan.id)).toThrow("已经绑定");
  });

  it("allows a new task beside a paused plan and rejects invalid resumes", async () => {
    const workspace = setup();
    const old = createSessionPlan(workspace, "plan-session", turnId, ["旧任务", "验证"]);
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "waiting_user");
    const tool = createPlanCreateTool(workspace, () => loadConfig(workspace));
    const result = JSON.parse(await tool.execute({ goal: "完成新任务", steps: ["新任务", "验证新任务"] }, {
      executionMode: "plan", sessionId: "plan-session", turnId: "new-turn",
    }));
    expect(result.plan.turnId).toBe("new-turn");
    expect(readSessionPlan(workspace, "plan-session", turnId)?.steps[0].status).toBe("waiting_user");
    expect(() => resumeSessionPlan(workspace, "other-session", "resume", old.id)).toThrow("不存在");
    updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "failed");
    expect(() => resumeSessionPlan(workspace, "plan-session", "resume", old.id)).toThrow("已结束");
  });

  it("exposes only the current execution, retains approvals and clears user pauses", async () => {
    const workspace = setup();
    const manager = new PluginManager(workspace);
    await manager.loadCorePlugins();
    manager.setRuntimeDeps(loadConfig(workspace), new FakeModelClient([]), new MessageHistory(), "plan-session");
    const snapshot = async () => {
      let data: { activePlan: SessionPlan | null; currentTurnId?: string } | undefined;
      await manager.getRoutes().find((route) => route.path === "/plan")!.handler({} as never, {} as never, {
        url: new URL("http://localhost/plan?session_id=plan-session"),
        readBody: async () => "",
        sendJSON: (_status, body) => { data = body as typeof data; },
      });
      return data!;
    };
    try {
      const plan = createSessionPlan(workspace, "plan-session", turnId, ["设计", "执行"]);
      updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
      expect((await snapshot()).activePlan).toBeNull();
      await manager.beginTurn("plan-session", turnId, "plan");
      await manager.callOnBuildTurnPrompt("", 0, "plan-session");
      expect((await snapshot()).activePlan?.id).toBe(plan.id);
      await manager.callOnTurnEnd("approval_required", 1, "plan-session");
      expect((await snapshot()).activePlan?.steps[0].status).toBe("waiting_approval");
      updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
      updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "waiting_user");
      await manager.callOnTurnEnd("completed", 2, "plan-session");
      expect((await snapshot()).activePlan).toBeNull();
      await manager.endTurn("plan-session", turnId);
      await manager.beginTurn("plan-session", "resume-turn", "plan");
      await manager.callOnBuildTurnPrompt("", 0, "plan-session");
      expect((await snapshot()).activePlan).toBeNull();
      resumeSessionPlan(workspace, "plan-session", "resume-turn", plan.id);
      updateSessionPlanStep(workspace, "plan-session", turnId, "step-1", "in_progress");
      expect(await snapshot()).toMatchObject({ currentTurnId: "resume-turn", activePlan: { id: plan.id } });
      await manager.callOnTurnEnd("approval_required", 1, "plan-session");
      expect((await snapshot()).activePlan?.steps[0].status).toBe("waiting_approval");
      await manager.callOnError(new Error("会话已取消"), 1, "plan-session");
      expect((await snapshot()).activePlan).toBeNull();
      expect(readSessionPlan(workspace, "plan-session", turnId)?.steps[0]).toMatchObject({ status: "failed", summary: "会话已取消" });
    } finally {
      await manager.destroy();
    }
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
