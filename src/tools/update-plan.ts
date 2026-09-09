import type { Config, Tool } from "../types.js";
import { saveProgressPlan, type PlanStep } from "../plan-store.js";

export function createUpdatePlanTool(workspace: string, getConfig: () => Config): Tool {
  return {
    name: "update_plan",
    description: "展示或更新复杂任务的计划与进度。提交完整步骤列表；可修订、增删步骤。仅更新展示，不控制工具权限或暂停任务。",
    inputSchema: { type: "object", required: ["title", "steps"], properties: {
      title: { type: "string" }, plan_id: { type: "string", description: "可选的历史计划 ID，仅关联历史，不自动执行" },
      steps: { type: "array", items: { type: "object", required: ["id", "title", "status"], properties: {
        id: { type: "string" }, title: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "skipped"] }, summary: { type: "string" },
      } } },
    } },
    execute: async (args, context) => {
      try {
        if (!context?.sessionId || !context.turnId) throw new Error("缺少会话或轮次标识");
        if (typeof args.title !== "string" || !args.title.trim()) throw new Error("title 不能为空");
        if (args.plan_id !== undefined && typeof args.plan_id !== "string") throw new Error("plan_id 必须为字符串");
        const max = (context.config ?? getConfig()).plan?.maxSteps ?? 8;
        if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > max) throw new Error(`步骤数必须在 1 到 ${max} 之间`);
        const ids = new Set<string>();
        const steps: PlanStep[] = args.steps.map((value: unknown) => {
          if (!value || typeof value !== "object") throw new Error("步骤格式无效");
          const step = value as Record<string, unknown>;
          if (typeof step.id !== "string" || !step.id.trim() || ids.has(step.id.trim())) throw new Error("步骤 ID 必须非空且唯一");
          if (typeof step.title !== "string" || !step.title.trim()) throw new Error("步骤标题不能为空");
          if (typeof step.status !== "string" || !["pending", "in_progress", "completed", "failed", "skipped"].includes(step.status)) throw new Error("步骤状态无效");
          if (step.summary !== undefined && typeof step.summary !== "string") throw new Error("步骤摘要必须为字符串");
          ids.add(step.id.trim());
          return { id: step.id.trim(), title: step.title.trim(), status: step.status as PlanStep["status"], ...(typeof step.summary === "string" ? { summary: step.summary } : {}) };
        });
        return JSON.stringify({ plan: saveProgressPlan(workspace, context.sessionId, context.turnId, args.title.trim(), steps, args.plan_id as string | undefined) });
      } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
    },
  };
}
