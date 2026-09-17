import type { Config, Tool } from "../types.js";
import { createSessionPlan, findActiveSessionPlan, resumeSessionPlan, revisePendingPlanSteps, updateSessionPlanStep, type PlanStepStatus } from "../plan-store.js";
import { updateRun } from "../run-store.js";

function activePlanTurnId(workspacePath: string, sessionId: string, turnId: string): string {
  return findActiveSessionPlan(workspacePath, sessionId, turnId)?.turnId ?? turnId;
}

export function createPlanCreateTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "plan_create",
    description: "创建当前任务的目标与执行步骤。可先用只读工具调研；执行有副作用的工具前必须创建计划。目标描述最终预期结果，而不是第一步操作。",
    isAvailable: (_context, executionMode) => executionMode === "plan",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "当前任务最终要达成的明确结果，不要填写步骤或执行状态" },
        steps: { type: "array", items: { type: "string" }, description: "按执行顺序排列的简洁步骤标题" },
      },
      required: ["goal", "steps"],
    },
    execute: async (args, context) => {
      if (context?.executionMode !== "plan" || !context.sessionId || !context.turnId) return JSON.stringify({ error: "plan_create 仅可在计划模式中使用" });
      const activePlan = findActiveSessionPlan(workspacePath, context.sessionId, context.turnId);
      if (activePlan) return JSON.stringify({ error: "本轮已经绑定计划，不要重复创建" });
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      if (!goal) return JSON.stringify({ error: "goal 不能为空，请描述当前任务最终要达成的结果" });
      const steps = Array.isArray(args.steps) ? args.steps.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
      const maxSteps = (context.config ?? getConfig()).plan?.maxSteps ?? 100;
      if (steps.length < 1 || steps.length > maxSteps) return JSON.stringify({ error: `计划步骤数必须在 1 到 ${maxSteps} 之间` });
      return JSON.stringify({ plan: createSessionPlan(workspacePath, context.sessionId, context.turnId, steps, goal) });
    },
  };
}

export function createPlanResumeTool(workspacePath: string): Tool {
  return {
    name: "plan_resume",
    description: "仅在用户明确继续旧任务时，将指定未结束计划绑定到本轮。恢复后用 plan_update 开始步骤。新任务或无关问答不要调用。",
    isAvailable: (_context, executionMode) => executionMode === "plan",
    inputSchema: {
      type: "object",
      properties: { plan_id: { type: "string", description: "要继续执行的计划 ID" }, goal: { type: "string", description: "仅用于补充旧计划缺失的目标，必须依据用户明确要求，不得猜测" } },
      required: ["plan_id"],
    },
    execute: async (args, context) => {
      if (context?.executionMode !== "plan" || !context.sessionId || !context.turnId) return JSON.stringify({ error: "plan_resume 仅可在计划模式中使用" });
      if (typeof args.plan_id !== "string" || !args.plan_id) return JSON.stringify({ error: "缺少 plan_id" });
      try {
        return JSON.stringify({ plan: resumeSessionPlan(workspacePath, context.sessionId, context.turnId, args.plan_id, typeof args.goal === "string" ? args.goal : undefined) });
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export function createPlanUpdateTool(workspacePath: string): Tool {
  return {
    name: "plan_update",
    description: "在步骤开始、完成、失败、跳过或等待审批时更新计划状态。",
    isAvailable: (_context, executionMode) => executionMode === "plan",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "步骤 ID，例如 step-1" },
        status: { type: "string", enum: ["in_progress", "completed", "failed", "skipped"], description: "步骤新状态" },
        summary: { type: "string", description: "完成结果或失败原因摘要" },
      },
      required: ["step_id", "status"],
    },
    execute: async (args, context) => {
      if (context?.executionMode !== "plan" || !context.sessionId || !context.turnId) return JSON.stringify({ error: "plan_update 仅可在计划模式中使用" });
      const stepId = typeof args.step_id === "string" ? args.step_id : "";
      const allowed: PlanStepStatus[] = ["in_progress", "completed", "failed", "skipped"];
      const status = allowed.includes(args.status as PlanStepStatus) ? args.status as PlanStepStatus : undefined;
      if (!stepId || !status) return JSON.stringify({ error: "step_id 或 status 无效" });
      try {
        const planTurnId = activePlanTurnId(workspacePath, context.sessionId, context.turnId);
        return JSON.stringify({ plan: updateSessionPlanStep(workspacePath, context.sessionId, planTurnId, stepId, status, typeof args.summary === "string" ? args.summary : undefined) });
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export function createPlanReviseTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "plan_revise",
    description: "根据调研结果替换当前计划尚未开始的步骤。已开始或已结束的步骤会原样保留。",
    isAvailable: (_context, executionMode) => executionMode === "plan",
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" }, description: "用于替换全部 pending 尾部的新步骤标题" },
      },
      required: ["steps"],
    },
    execute: async (args, context) => {
      if (context?.executionMode !== "plan" || !context.sessionId || !context.turnId) return JSON.stringify({ error: "plan_revise 仅可在计划模式中使用" });
      const steps = Array.isArray(args.steps)
        ? args.steps.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
        : [];
      const maxSteps = (context.config ?? getConfig()).plan?.maxSteps ?? 100;
      try {
        const planTurnId = activePlanTurnId(workspacePath, context.sessionId, context.turnId);
        return JSON.stringify({ plan: revisePendingPlanSteps(workspacePath, context.sessionId, planTurnId, steps, maxSteps) });
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export function createPlanPauseTool(workspacePath: string): Tool {
  return {
    name: "plan_pause",
    description: "当前步骤需要用户确认或补充信息时暂停计划。输出说明后调用本工具，下一轮用户回复后可继续原计划。",
    isAvailable: (_context, executionMode) => executionMode === "plan",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "已经给用户的信息以及等待确认的事项" } },
      required: ["summary"],
    },
    execute: async (args, context) => {
      if (context?.executionMode !== "plan" || !context.sessionId || !context.turnId) return JSON.stringify({ error: "plan_pause 仅可在计划模式中使用" });
      const plan = findActiveSessionPlan(workspacePath, context.sessionId, context.turnId);
      if (!plan || plan.status === "completed" || plan.status === "failed") return JSON.stringify({ error: "暂停前必须有未完成计划" });
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) return JSON.stringify({ error: "summary 不能为空" });
      const run = updateRun(workspacePath, context.sessionId, context.turnId, { state: "waiting_user", reason: summary });
      if (!run) return JSON.stringify({ error: "缺少当前运行记录，无法暂停" });
      return JSON.stringify({ plan, run });
    },
  };
}
