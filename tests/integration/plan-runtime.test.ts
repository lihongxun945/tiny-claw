import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession, type AgentEvent } from "../../src/agent.js";
import { PluginManager } from "../../src/plugin-manager.js";
import type { PluginContext } from "../../src/plugins/types.js";
import type { ChatResponse, ToolUseBlock } from "../../src/types.js";
import { readRun, startRun, updateRun } from "../../src/run-store.js";
import { readSessionPlan, readPlanSnapshot } from "../../src/plan-store.js";
import { createSessionMeta, sessionDir } from "../../src/session-store.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { FakeModelClient, type ScriptedChat } from "../helpers/fake-model-client.js";
import { requestApproval, approveRequest, listSessionApprovalContinuations } from "../../src/tools/approval.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const call = (name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id: crypto.randomUUID(), name, input });
const batch = (...toolCalls: ToolUseBlock[]): ChatResponse => ({ text: "", toolCalls });
const create = () => call("update_plan", { title: "验证功能", steps: [{ id: "verify", title: "验证", status: "pending" }] });
const answer: ChatResponse = { text: "结果", toolCalls: [] };
async function setup(script: ScriptedChat[], maxGateCorrections = 2) {
  const workspace = createTempWorkspace({ plan: { maxGateCorrections } });
  const manager = new PluginManager(workspace);
  cleanups.push(async () => { await manager.destroy(); removeTempWorkspace(workspace); });
  await manager.loadCorePlugins();
  const execute = vi.fn(async () => "ok");
  const ctx = (manager as unknown as { createPluginContext(name: string): PluginContext }).createPluginContext("test-runtime");
  ctx.registerTool({ name: "work", description: "work", inputSchema: { type: "object" }, execute });
  const client = new FakeModelClient(script);
  const session = new AgentSession("s", workspace, manager, {}, client);
  return { workspace, client, session, execute, ctx, manager };
}
async function collect(source: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of source) result.push(event); return result; }

it.each(["normal", "plan"] as const)("executes without a plan in %s mode", async (mode) => {
  const { session, execute, workspace, client } = await setup([batch(call("work")), answer]);
  const events = await collect(session.chat("执行", undefined, undefined, mode, "t"));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(client.calls[0].tools?.map(t => t.name)).toEqual(expect.arrayContaining(["work", "update_plan"]));
  expect(client.calls[0].tools?.map(t => t.name)).not.toContain("plan_create");
  expect(readSessionPlan(workspace, "s", "t")).toBeUndefined();
  expect(events.at(-1)).toMatchObject({ reason: "completed" });
});

it("answers without any plan or auxiliary model call", async () => {
  const { session, client, workspace } = await setup([answer]);
  await collect(session.chat("解释", undefined, undefined, "normal", "t"));
  expect(client.calls).toHaveLength(1);
  expect(client.decisionCalls).toHaveLength(0);
  expect(readSessionPlan(workspace, "s", "t")).toBeUndefined();
});

it("invalid progress does not block the remaining batch or pause the run", async () => {
  const { session, execute, workspace } = await setup([batch(call("update_plan", { title: "", steps: [] }), call("work")), answer], 0);
  await collect(session.chat("执行", undefined, undefined, "plan", "t"));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(readRun(workspace, "s", "t")?.state).toBe("completed");
});

it("revises steps freely and keeps completed progress separate from execution", async () => {
  const { session, execute, workspace } = await setup([
    batch(create(), call("work")),
    batch(call("update_plan", { title: "验证功能", steps: [{ id: "new", title: "改进后验证", status: "completed" }] }), call("work")),
    answer,
  ]);
  await collect(session.chat("执行", undefined, undefined, "normal", "t"));
  expect(execute).toHaveBeenCalledTimes(2);
  expect(readPlanSnapshot(workspace, "s", "t")).toMatchObject({ status: "completed", steps: [{ id: "new" }] });
});

it("does not mark unfinished progress complete when a turn ends", async () => {
  const { session, workspace } = await setup([batch(create()), answer]);
  await collect(session.chat("执行", undefined, undefined, "normal", "t"));
  expect(readRun(workspace, "s", "t")?.state).toBe("completed");
  expect(readPlanSnapshot(workspace, "s", "t")?.steps[0].status).toBe("pending");
});

it("links a later update without mutating earlier plans or snapshots", async () => {
  let previous = "";
  const { session, workspace } = await setup([
    batch(create()), answer,
    () => batch(call("update_plan", { plan_id: previous, title: "继续验证", steps: [{ id: "verify", title: "验证", status: "completed" }] })), answer,
    answer,
  ]);
  await collect(session.chat("执行", undefined, undefined, "normal", "old"));
  previous = readSessionPlan(workspace, "s", "old")!.id;
  await collect(session.chat("完成验证", undefined, undefined, "normal", "new"));
  expect(readSessionPlan(workspace, "s", "new")?.previousPlanId).toBe(previous);
  expect(readPlanSnapshot(workspace, "s", "old")?.steps[0].status).toBe("pending");
  await collect(session.chat("无关问题", undefined, undefined, "normal", "other"));
  expect(readSessionPlan(workspace, "s", "other")).toBeUndefined();
});

it("disabled progress does not disable legacy-mode execution", async () => {
  const workspace = createTempWorkspace({ plan: { enabled: false } });
  const manager = new PluginManager(workspace);
  cleanups.push(async () => { await manager.destroy(); removeTempWorkspace(workspace); });
  await manager.loadCorePlugins();
  const client = new FakeModelClient([answer]);
  const session = new AgentSession("disabled", workspace, manager, {}, client);
  expect((await collect(session.chat("回答", undefined, undefined, "plan", "t"))).at(-1)).toMatchObject({ reason: "completed" });
  expect(client.calls[0].tools?.some(t => t.name === "update_plan")).toBe(false);
});

it("duplicate turns cannot replay side effects", async () => {
  const { session, execute } = await setup([batch(create(), call("work")), answer]);
  await collect(session.chat("执行", undefined, undefined, "plan", "t"));
  const events = await collect(session.chat("执行", undefined, undefined, "plan", "t"));
  expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("不能重复执行") });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("recovers foreign-process runs as interrupted and preserves unknown tool outcomes", () => {
  const workspace = createTempWorkspace();
  cleanups.push(async () => removeTempWorkspace(workspace));
  createSessionMeta(workspace, "s");
  startRun(workspace, "s", "t", "plan");
  updateRun(workspace, "s", "t", { pendingToolCallId: "unknown" });
  const path = resolve(sessionDir(workspace, "s"), "runs/t.json");
  const run = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...run, owner: "previous-process" }));
  expect(readRun(workspace, "s", "t")).toMatchObject({ state: "interrupted", pendingToolCallId: "unknown" });
  expect(() => startRun(workspace, "s", "t", "plan")).toThrow("不能重复执行");
});

it.each(["approve", "cancel"])("restores a plan approval then handles %s without duplicate effects", async (action) => {
  const { workspace, session, ctx, manager } = await setup([batch(create(), call("gated"))]);
  const effect = vi.fn();
  const execute = async () => {
    const permission = requestApproval(workspace, "gated", {}, undefined, undefined, "s");
    if (!permission.approved) return JSON.stringify({ requiresConfirmation: true, approvalId: permission.approval!.id });
    effect();
    return "ok";
  };
  ctx.registerTool({ name: "gated", description: "gated", inputSchema: { type: "object" }, execute });
  await collect(session.chat("执行", undefined, undefined, "plan", "t"));
  const before = readRun(workspace, "s", "t")!;
  expect(before.state).toBe("waiting_approval");
  expect(readSessionPlan(workspace, "s", "t")?.steps[0].status).toBe("pending");
  const restored = new AgentSession("s", workspace, manager, {}, new FakeModelClient([answer]));
  if (action === "approve") {
    approveRequest(workspace, before.approvalId!);
    await collect(restored.resumeApproval(before.approvalId!));
    await collect(restored.resumeApproval(before.approvalId!));
    expect(effect).toHaveBeenCalledTimes(1);
    expect(readRun(workspace, "s", "t")).toMatchObject({ id: before.id, state: "completed" });
  } else {
    expect(await restored.cancelPendingApprovals()).toBe(true);
    expect(await restored.cancelPendingApprovals()).toBe(false);
    expect(effect).not.toHaveBeenCalled();
    expect(readRun(workspace, "s", "t")?.state).toBe("cancelled");
  }
  expect(listSessionApprovalContinuations(workspace, "s")).toEqual([]);
});
