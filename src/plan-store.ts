import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sessionDir } from "./session-store.js";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped" | "waiting_approval" | "waiting_user";
export type PlanStatus = "planning" | "executing" | "completed" | "failed";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  summary?: string;
}

export interface SessionPlan {
  id: string;
  turnId: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  currentStepId?: string;
  revision?: number;
  steps: PlanStep[];
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
    ?? listSessionPlans(workspacePath, sessionId).reverse().find((plan) => (
      plan.status === "planning" || plan.status === "executing"
    ));
}

export function createSessionPlan(workspacePath: string, sessionId: string, turnId: string, titles: string[]): SessionPlan {
  const now = new Date().toISOString();
  const plan: SessionPlan = {
    id: randomUUID(),
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
  if (retained.length + titles.length < 2 || retained.length + titles.length > maxSteps) {
    throw new Error(`调整后计划步骤数必须在 2 到 ${maxSteps} 之间`);
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
  status: "in_progress" | "waiting_approval" | "failed",
  summary?: string,
): SessionPlan | undefined {
  const plan = readSessionPlan(workspacePath, sessionId, turnId);
  const step = plan?.steps.find((item) => item.id === plan.currentStepId);
  if (!plan || !step) return plan;
  return updateSessionPlanStep(workspacePath, sessionId, turnId, step.id, status, summary);
}

export function completeFinalPlanStep(
  workspacePath: string,
  sessionId: string,
  turnId: string,
): SessionPlan | undefined {
  const plan = readSessionPlan(workspacePath, sessionId, turnId);
  if (!plan?.currentStepId) return plan;
  const currentIndex = plan.steps.findIndex((step) => step.id === plan.currentStepId);
  if (currentIndex < 0 || plan.steps[currentIndex].status !== "in_progress") return plan;
  const hasUnfinishedOtherStep = plan.steps.some((step, index) => (
    index !== currentIndex && step.status !== "completed" && step.status !== "skipped"
  ));
  if (hasUnfinishedOtherStep) return plan;
  return updateSessionPlanStep(
    workspacePath,
    sessionId,
    turnId,
    plan.currentStepId,
    "completed",
    "已完成并输出最终结果",
  );
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
    waiting_approval: ["in_progress", "failed"],
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
