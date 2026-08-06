import type { Plugin } from "../types.js";
import { loadConfig } from "../../config.js";
import { completeFinalPlanStep, failSessionPlan, listSessionPlans, markCurrentPlanStep, readSessionPlan } from "../../plan-store.js";
import { createPlanCreateTool, createPlanUpdateTool } from "../../tools/plan.js";
import { withAudit } from "./tools.js";

const PLAN_PROMPT = `## 计划执行模式
你必须先调用 plan_create 创建 2 到配置上限个可验证步骤，禁止在创建计划前调用其他工具。
执行每一步前调用 plan_update 将其设为 in_progress；完成后设为 completed 并写简短 summary。
同一时间只能有一个执行中步骤，必须按顺序执行。不得披露内部推理，只描述可观察的目标和结果。
所有步骤完成后才能输出最终总结；发现失败时将当前步骤设为 failed。`;

export const corePlanPlugin: Plugin = {
  name: "core-plan",
  async init(ctx) {
    const getConfig = () => loadConfig(ctx.workspacePath);
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanCreateTool(ctx.workspacePath, getConfig)));
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanUpdateTool(ctx.workspacePath)));
    ctx.registerRoute({
      method: "GET",
      path: "/plan",
      async handler(_req, _res, routeCtx) {
        const sessionId = routeCtx.url.searchParams.get("session_id");
        if (!sessionId) return routeCtx.sendJSON(400, { error: "缺少 session_id" });
        const plans = listSessionPlans(ctx.workspacePath, sessionId);
        routeCtx.sendJSON(200, { plans });
      },
    });
    ctx.registerHooks({
      onBuildTurnPrompt(hookCtx, prompt) {
        if (hookCtx.executionMode !== "plan") return prompt;
        return `${prompt}\n\n${PLAN_PROMPT}`;
      },
      onBeforeTool(hookCtx, name) {
        if (hookCtx.executionMode !== "plan" || name === "plan_create" || name === "plan_update") return;
        if (!hookCtx.turnId) return { abort: "计划模式缺少轮次标识" };
        const plan = readSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        if (!plan) return { abort: "计划模式必须先调用 plan_create" };
        const current = plan.steps.find((step) => step.id === plan.currentStepId);
        if (current?.status === "waiting_approval") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "in_progress");
        else if (current?.status !== "in_progress") return { abort: "执行工具前必须调用 plan_update 将当前步骤设为 in_progress" };
      },
      onChatResponse(hookCtx, response) {
        if (hookCtx.executionMode !== "plan" || response.toolCalls.length > 0) return response;
        if (!hookCtx.turnId) return response;
        let plan = readSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        if (plan?.status === "completed" || plan?.status === "failed") return response;
        plan = completeFinalPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        if (plan?.status === "completed") return response;
        return { ...response, text: `计划执行异常：Agent 在全部步骤完成前结束了任务。\n\n${response.text}` };
      },
      onTurnEnd(hookCtx, reason) {
        if (hookCtx.executionMode !== "plan") return;
        if (!hookCtx.turnId) return;
        if (reason === "approval_required") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "waiting_approval");
        if (reason === "iteration_limit") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "failed", "达到 Agent 迭代上限");
        if (reason === "completed") {
          const plan = readSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
          if (!plan || (plan.status !== "completed" && plan.status !== "failed")) failSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "Agent 在计划完成前结束任务");
        }
      },
      onError(hookCtx, error) {
        if (hookCtx.executionMode === "plan" && hookCtx.turnId) markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "failed", error.message);
      },
    });
  },
};
