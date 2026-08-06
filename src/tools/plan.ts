import type { Config, Tool } from "../types.js";
import { createSessionPlan, updateSessionPlanStep, type PlanStepStatus } from "../plan-store.js";

export function createPlanCreateTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "plan_create",
    description: "创建当前任务的结构化执行计划。计划模式下必须先调用本工具，再执行其他工具。",
    isAvailable: (_context, executionMode) => executionMode === "plan",
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" }, description: "按执行顺序排列的简洁步骤标题" },
      },
      required: ["steps"],
    },
    execute: async (args, context) => {
      if (context?.executionMode !== "plan" || !context.sessionId || !context.turnId) return JSON.stringify({ error: "plan_create 仅可在计划模式中使用" });
      const steps = Array.isArray(args.steps) ? args.steps.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
      const maxSteps = (context.config ?? getConfig()).plan?.maxSteps ?? 8;
      if (steps.length < 2 || steps.length > maxSteps) return JSON.stringify({ error: `计划步骤数必须在 2 到 ${maxSteps} 之间` });
      return JSON.stringify({ plan: createSessionPlan(workspacePath, context.sessionId, context.turnId, steps) });
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
        return JSON.stringify({ plan: updateSessionPlanStep(workspacePath, context.sessionId, context.turnId, stepId, status, typeof args.summary === "string" ? args.summary : undefined) });
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
