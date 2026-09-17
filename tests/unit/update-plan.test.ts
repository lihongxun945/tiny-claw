import { afterEach, expect, it } from "vitest";
import { createUpdatePlanTool } from "../../src/tools/update-plan.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { readSessionPlan } from "../../src/plan-store.js";
import { createSessionMeta } from "../../src/session-store.js";

const workspaces: string[] = [];
afterEach(() => { for (const w of workspaces.splice(0)) removeTempWorkspace(w); });
it("retains the current title when updating only steps, including an explicit plan ID", async () => {
  const workspace = createTempWorkspace(); workspaces.push(workspace);
  createSessionMeta(workspace, "s", { mode: "chat" });
  const tool = createUpdatePlanTool(workspace, () => loadConfig(workspace));
  const context = { sessionId: "s", turnId: "t" };
  const step = { id: "s1", title: "步骤", status: "pending" };
  const first = JSON.parse(await tool.execute({ title: "整体标题", steps: [step] }, context)).plan;
  for (const plan_id of [undefined, first.id]) {
    const result = JSON.parse(await tool.execute({ plan_id, steps: [{ ...step, status: "completed" }] }, context));
    expect(result.plan).toMatchObject({ id: first.id, goal: "整体标题", status: "completed" });
  }
  expect(JSON.parse(await tool.execute({ title: "新标题", steps: [step] }, context)).plan.goal).toBe("新标题");
  expect(tool.inputSchema.required).toEqual(["steps"]);
});

it("inherits only an explicitly linked history title and does not modify the old plan", async () => {
  const workspace = createTempWorkspace(); workspaces.push(workspace);
  createSessionMeta(workspace, "s", { mode: "chat" });
  const tool = createUpdatePlanTool(workspace, () => loadConfig(workspace));
  const steps = [{ id: "s1", title: "步骤", status: "pending" }];
  const original = JSON.parse(await tool.execute({ title: "历史标题", steps }, { sessionId: "s", turnId: "old" })).plan;
  const context = { sessionId: "s", turnId: "new" };
  expect(JSON.parse(await tool.execute({ steps }, context)).error).toContain("新建计划需要提供顶层 title");
  expect(readSessionPlan(workspace, "s", "new")).toBeUndefined();
  expect(JSON.parse(await tool.execute({ plan_id: original.id, steps }, { sessionId: "other", turnId: "new" })).error).toContain("不存在");
  const result = JSON.parse(await tool.execute({ plan_id: original.id, steps }, context));
  expect(result.plan).toMatchObject({ goal: "历史标题", previousPlanId: original.id, turnId: "new" });
  expect(result.plan.id).not.toBe(original.id);
  await tool.execute({ title: "本轮标题", steps }, context);
  expect(JSON.parse(await tool.execute({ plan_id: original.id, steps }, context)).plan.goal).toBe("本轮标题");
  expect(readSessionPlan(workspace, "s", "old")).toEqual(original);
});

it.each(["", "   ", null, 123])("rejects an explicitly invalid title without changing progress: %j", async title => {
  const workspace = createTempWorkspace(); workspaces.push(workspace);
  createSessionMeta(workspace, "s", { mode: "chat" });
  const tool = createUpdatePlanTool(workspace, () => loadConfig(workspace));
  const context = { sessionId: "s", turnId: "t" };
  const steps = [{ id: "s1", title: "步骤", status: "pending" }];
  await tool.execute({ title: "原标题", steps }, context);
  const before = readSessionPlan(workspace, "s", "t");
  expect(before?.goal).toBe("原标题");
  expect(JSON.parse(await tool.execute({ title, steps }, context)).error).toContain("顶层 title");
  expect(readSessionPlan(workspace, "s", "t")).toEqual(before);
});

it.each([
  { title: "", steps: [] },
  { title: "任务", steps: [{ id: "a", title: "步骤", status: "waiting_user" }] },
  { title: "任务", steps: [{ id: "a", title: "步骤", status: "pending" }, { id: "a", title: "重复", status: "pending" }] },
  { title: "任务", plan_id: "another-session-plan", steps: [{ id: "a", title: "步骤", status: "pending" }] },
])("rejects malformed progress without creating a partial plan: %j", async (args) => {
  const workspace = createTempWorkspace(); workspaces.push(workspace);
  const tool = createUpdatePlanTool(workspace, () => loadConfig(workspace));
  expect(JSON.parse(await tool.execute(args, { sessionId: "s", turnId: "t" })).error).toBeTruthy();
  expect(readSessionPlan(workspace, "s", "t")).toBeUndefined();
});
it("validates the configured limit and preserves the previous revision on failure", async () => {
  const workspace = createTempWorkspace({ plan: { maxSteps: 1 } }); workspaces.push(workspace);
  createSessionMeta(workspace, "s", { mode: "chat" });
  const tool = createUpdatePlanTool(workspace, () => loadConfig(workspace));
  const step = { id: "a", title: "步骤", status: "pending" };
  const context = { sessionId: "s", turnId: "t" };
  await tool.execute({ title: "任务", steps: [step] }, context);
  const before = readSessionPlan(workspace, "s", "t");
  expect(before?.goal).toBe("任务");
  expect(JSON.parse(await tool.execute({ title: "修改", steps: [step, { ...step, id: "b" }] }, context)).error).toBeTruthy();
  expect(readSessionPlan(workspace, "s", "t")).toEqual(before);
});
