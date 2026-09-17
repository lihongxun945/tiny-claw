import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sessionDir } from "./session-store.js";
import { listRuns } from "./run-store.js";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped" | "waiting_approval" | "waiting_user";
export type PlanStatus = "planning" | "executing" | "completed" | "failed";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  summary?: string;
}

export interface SessionPlan {
  previousPlanId?: string;
  id: string;
  goal?: string;
  turnId: string;
  relatedTurnIds?: string[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  currentStepId?: string;
  revision?: number;
  steps: PlanStep[];
}

export function saveProgressPlan(workspace: string, session: string, turn: string, title: string | undefined, steps: PlanStep[], previousPlanId?: string): SessionPlan {
  const current = readSessionPlan(workspace, session, turn);
  const previous = previousPlanId ? listSessionPlans(workspace, session).find(plan => plan.id === previousPlanId) : undefined;
  if (previousPlanId && !previous) throw new Error("当前会话中不存在所关联的计划");
  const resolvedTitle = title ?? (current?.goal?.trim() || previous?.goal?.trim());
  if (!resolvedTitle?.trim()) throw new Error("新建计划需要提供顶层 title（计划整体标题）；本轮及所关联计划均无可用标题");
  const now = new Date().toISOString();
  const plan: SessionPlan = {
    id: current?.id ?? randomUUID(), turnId: turn, goal: resolvedTitle, steps,
    previousPlanId: previousPlanId === current?.id ? current?.previousPlanId : previousPlanId ?? current?.previousPlanId,
    createdAt: current?.createdAt ?? now, updatedAt: now, revision: (current?.revision ?? 0) + 1,
    currentStepId: steps.find(step => step.status === "in_progress")?.id,
    status: steps.every(step => step.status === "completed" || step.status === "skipped") ? "completed" : "executing",
  };
  writeSessionPlan(workspace, session, plan);
  return plan;
}

export function plansDir(workspacePath: string, sessionId: string): string {
  return resolve(sessionDir(workspacePath, sessionId), "plans");
}

export function planFilePath(workspacePath: string, sessionId: string, turnId: string): string {
  return resolve(plansDir(workspacePath, sessionId), `${turnId}.json`);
}

export function readSessionPlan(workspacePath: string, sessionId: string, turnId: string): SessionPlan | undefined {
  try {
    const value = JSON.parse(readFileSync(planFilePath(workspacePath, sessionId, turnId), "utf-8")) as SessionPlan;
    if (!value || !Array.isArray(value.steps) || typeof value.id !== "string" || value.turnId !== turnId) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function listSessionPlans(workspacePath: string, sessionId: string): SessionPlan[] {
  const dir = plansDir(workspacePath, sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readSessionPlan(workspacePath, sessionId, name.slice(0, -5)))
    .filter((plan): plan is SessionPlan => plan !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findActiveSessionPlan(workspacePath: string, sessionId: string, turnId: string): SessionPlan | undefined {
  return readSessionPlan(workspacePath, sessionId, turnId)
    ?? listSessionPlans(workspacePath, sessionId).find((plan) => plan.relatedTurnIds?.includes(turnId));
}

export function planExecutionIssue(plan: SessionPlan | undefined): string | undefined {
  if (!plan) return "本轮尚未绑定计划";
  if (plan.status === "completed" || plan.status === "failed") return "已结束的计划不能恢复";
  if (!plan.goal?.trim()) return "旧计划缺少目标，请在 plan_resume 中明确提供 goal 后恢复，不要猜测用户目标";
  if (!plan.steps.some((step) => ["pending", "in_progress", "waiting_user", "waiting_approval"].includes(step.status))) return "计划没有可继续执行的步骤";
}

export function resumeSessionPlan(workspacePath: string, sessionId: string, turnId: string, planId: string, goal?: string): SessionPlan {
  if (findActiveSessionPlan(workspacePath, sessionId, turnId)) throw new Error("本轮已经绑定计划");
  const plan = listSessionPlans(workspacePath, sessionId).find((item) => item.id === planId);
  if (!plan) throw new Error("当前会话中不存在该计划");
  if (!plan.goal?.trim() && goal?.trim()) plan.goal = goal.trim();
  const issue = planExecutionIssue(plan);
  if (issue) throw new Error(issue);
  if (listRuns(workspacePath, sessionId).some((run) => run.planId === plan.id && (run.state === "running" || run.state === "waiting_approval"))) throw new Error("原计划仍在运行或等待审批");
  if (plan.steps.some((step) => step.status === "waiting_approval")) throw new Error("请先处理原任务的工具审批");
  plan.relatedTurnIds = [...(plan.relatedTurnIds ?? []), turnId];
  plan.updatedAt = new Date().toISOString();
  writeSessionPlan(workspacePath, sessionId, plan);
  return plan;
}

export function createSessionPlan(workspacePath: string, sessionId: string, turnId: string, titles: string[], goal?: string): SessionPlan {
  const now = new Date().toISOString();
  const plan: SessionPlan = {
    id: randomUUID(),
    goal: goal?.trim() || undefined,
    turnId,
    status: "planning",
    createdAt: now,
    updatedAt: now,
    steps: titles.map((title, index) => ({ id: `step-${index + 1}`, title, status: "pending" })),
  };
  writeSessionPlan(workspacePath, sessionId, plan);
  return plan;
}

export function updateSessionPlanStep(
  workspacePath: string,
  sessionId: string,
  turnId: string,
  stepId: string,
  status: PlanStepStatus,
  summary?: string,
): SessionPlan {
  const plan = readSessionPlan(workspacePath, sessionId, turnId);
  if (!plan) throw new Error("当前会话还没有计划，请先调用 plan_create");
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`计划步骤不存在: ${stepId}`);
  const step = plan.steps[index];
  validateTransition(plan, index, status);
  step.status = status;
  if (summary !== undefined) step.summary = summary;
  plan.currentStepId = status === "in_progress" || status === "waiting_approval" || status === "waiting_user" ? step.id : undefined;
  plan.status = plan.steps.every((item) => item.status === "completed" || item.status === "skipped")
    ? "completed"
    : plan.steps.some((item) => item.status === "failed")
      ? "failed"
      : plan.steps.some((item) => item.status !== "pending") ? "executing" : "planning";
  plan.updatedAt = new Date().toISOString();
  writeSessionPlan(workspacePath, sessionId, plan);
  return plan;
}

export function revisePendingPlanSteps(
  workspacePath: string,
  sessionId: string,
  turnId: string,
  titles: string[],
  maxSteps: number,
): SessionPlan {
  const plan = readSessionPlan(workspacePath, sessionId, turnId);
  if (!plan) throw new Error("当前会话还没有计划，请先调用 plan_create");
  const firstPendingIndex = plan.steps.findIndex((step) => step.status === "pending");
  if (firstPendingIndex < 0) throw new Error("当前计划没有可调整的待执行步骤");
  if (plan.steps.slice(firstPendingIndex).some((step) => step.status !== "pending")) {
    throw new Error("只能调整计划末尾连续的待执行步骤");
  }
  const retained = plan.steps.slice(0, firstPendingIndex);
  if (retained.length + titles.length < 1 || retained.length + titles.length > maxSteps) {
    throw new Error(`调整后计划步骤数必须在 1 到 ${maxSteps} 之间`);
  }
  const nextStepNumber = plan.steps.reduce((max, step) => {
    const match = /^step-(\d+)$/.exec(step.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  plan.steps = [
    ...retained,
    ...titles.map((title, index) => ({ id: `step-${nextStepNumber + index}`, title, status: "pending" as const })),
  ];
  plan.revision = (plan.revision ?? 0) + 1;
  plan.updatedAt = new Date().toISOString();
  writeSessionPlan(workspacePath, sessionId, plan);
  return plan;
}

export function markCurrentPlanStep(
  workspacePath: string,
  sessionId: string,
  turnId: string,
  status: "in_progress" | "waiting_approval" | "waiting_user" | "failed",
  summary?: string,
): SessionPlan | undefined {
  const plan = readSessionPlan(workspacePath, sessionId, turnId);
  const step = plan?.steps.find((item) => item.id === plan.currentStepId);
  if (!plan || !step) return plan;
  return updateSessionPlanStep(workspacePath, sessionId, turnId, step.id, status, summary);
}

export function failSessionPlan(workspacePath: string, sessionId: string, turnId: string, summary: string): SessionPlan {
  let plan = readSessionPlan(workspacePath, sessionId, turnId);
  if (!plan) plan = createSessionPlan(workspacePath, sessionId, turnId, ["创建执行计划", "执行并验证任务"]);
  const current = plan.steps.find((step) => step.id === plan.currentStepId);
  if (current) return updateSessionPlanStep(workspacePath, sessionId, turnId, current.id, "failed", summary);
  const pending = plan.steps.find((step) => step.status === "pending");
  if (!pending) return plan;
  updateSessionPlanStep(workspacePath, sessionId, turnId, pending.id, "in_progress");
  return updateSessionPlanStep(workspacePath, sessionId, turnId, pending.id, "failed", summary);
}

function validateTransition(plan: SessionPlan, index: number, next: PlanStepStatus): void {
  const current = plan.steps[index].status;
  if (current === next) return;
  const allowed: Record<PlanStepStatus, PlanStepStatus[]> = {
    pending: ["in_progress", "skipped"],
    in_progress: ["completed", "failed", "waiting_approval", "waiting_user"],
    waiting_approval: ["in_progress", "waiting_user", "failed"],
    waiting_user: ["in_progress", "failed"],
    completed: [],
    failed: [],
    skipped: [],
  };
  if (!allowed[current].includes(next)) throw new Error(`不允许将步骤从 ${current} 更新为 ${next}`);
  if (next === "in_progress") {
    if (plan.steps.some((step, stepIndex) => stepIndex !== index && (step.status === "in_progress" || step.status === "waiting_approval" || step.status === "waiting_user"))) {
      throw new Error("同一时间只能执行一个计划步骤");
    }
    if (plan.steps.slice(0, index).some((step) => step.status !== "completed" && step.status !== "skipped")) {
      throw new Error("必须按顺序执行计划步骤");
    }
  }
}

function writeSessionPlan(workspacePath: string, sessionId: string, plan: SessionPlan): void {
  const path = planFilePath(workspacePath, sessionId, plan.turnId);
  const tempPath = `${path}.${process.pid}.tmp`;
  if (!existsSync(sessionDir(workspacePath, sessionId))) throw new Error("会话不存在，无法保存计划");
  mkdirSync(plansDir(workspacePath, sessionId), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  renameSync(tempPath, path);
}

export function savePlanSnapshot(workspace: string, session: string, turn: string): void {
  const plan = findActiveSessionPlan(workspace, session, turn);
  if (!plan) return;
  const dir = resolve(sessionDir(workspace, session), "plan-snapshots");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${encodeURIComponent(turn)}.json`);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(plan), "utf8");
  renameSync(temp, path);
}

export function readPlanSnapshot(workspace: string, session: string, turn: string): SessionPlan | undefined {
  const path = resolve(sessionDir(workspace, session), "plan-snapshots", `${encodeURIComponent(turn)}.json`);
  if (!existsSync(path)) return;
  return JSON.parse(readFileSync(path, "utf8")) as SessionPlan;
}
