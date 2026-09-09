import { afterEach, expect, it } from "vitest";
import { createUpdatePlanTool } from "../../src/tools/update-plan.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { readSessionPlan } from "../../src/plan-store.js";

const workspaces: string[] = [];
afterEach(() => { for (const w of workspaces.splice(0)) removeTempWorkspace(w); });
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
  const tool = createUpdatePlanTool(workspace, () => loadConfig(workspace));
  const step = { id: "a", title: "步骤", status: "pending" };
  const context = { sessionId: "s", turnId: "t" };
  await tool.execute({ title: "任务", steps: [step] }, context);
  const before = readSessionPlan(workspace, "s", "t");
  expect(JSON.parse(await tool.execute({ title: "修改", steps: [step, { ...step, id: "b" }] }, context)).error).toBeTruthy();
  expect(readSessionPlan(workspace, "s", "t")).toEqual(before);
});
