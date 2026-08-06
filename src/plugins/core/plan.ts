import type { ModelCallContext, Plugin } from "../types.js";
import type { ToolDefinition } from "../../types.js";
import { loadConfig } from "../../config.js";
import { completeFinalPlanStep, failSessionPlan, findActiveSessionPlan, listSessionPlans, markCurrentPlanStep } from "../../plan-store.js";
import { createPlanCreateTool, createPlanPauseTool, createPlanReviseTool, createPlanUpdateTool } from "../../tools/plan.js";
import { withAudit } from "./tools.js";

const PLAN_PROMPT = `## 计划执行模式
如果用户问题无需调用任何工具就能准确回答，可以直接回答，不要创建计划。
如果任务需要调用工具，你必须先调用 plan_create 创建 2 到配置上限个可验证步骤，禁止在创建计划前调用其他工具。信息不足时先创建包含“调研现状”和“根据调研结果细化计划”的初步计划。
执行每一步前调用 plan_update 将其设为 in_progress；完成后设为 completed 并写简短 summary。
调研完成后调用 plan_revise，将全部尚未执行的步骤替换为基于调研结果的具体步骤，再继续执行。
同一时间只能有一个执行中步骤，必须按顺序执行。不得披露内部推理，只描述可观察的目标和结果。
需要用户确认或补充信息时，先清晰输出待确认内容，再调用 plan_pause 暂停；用户下一轮回复后继续原计划。
所有步骤完成后才能输出最终总结；发现失败时将当前步骤设为 failed。`;

function filterPlanTools(
  definitions: ToolDefinition[],
  plan: ReturnType<typeof findActiveSessionPlan>,
): ToolDefinition[] {
  if (!plan) return definitions.filter((definition) => definition.name === "plan_create");
  if (plan.status === "completed" || plan.status === "failed") return [];
  const current = plan.steps.find((step) => step.id === plan.currentStepId);
  if (current?.status === "in_progress") {
    return definitions.filter((definition) => definition.name !== "plan_create");
  }
  return definitions.filter((definition) => definition.name === "plan_update" || definition.name === "plan_revise");
}

function reportPlanStatus(
  reportStatus: NonNullable<ModelCallContext["reportStatus"]>,
  plan: ReturnType<typeof findActiveSessionPlan>,
): void {
  if (!plan) {
    reportStatus({ stage: "plan", state: "started", message: "正在生成执行计划…" });
    return;
  }
  if (plan.status === "completed") {
    reportStatus({ stage: "plan", state: "started", message: "计划已完成，正在整理最终结果…" });
    return;
  }
  const currentIndex = plan.steps.findIndex((step) => step.id === plan.currentStepId);
  const nextIndex = currentIndex >= 0
    ? currentIndex
    : plan.steps.findIndex((step) => step.status === "pending");
  const step = plan.steps[nextIndex];
  if (!step) return;
  const prefix = step.status === "in_progress" ? "正在执行" : "正在准备";
  reportStatus({
    stage: "plan",
    state: "started",
    message: `${prefix}第 ${nextIndex + 1}/${plan.steps.length} 步：${step.title}`,
  });
}

export const corePlanPlugin: Plugin = {
  name: "core-plan",
  async init(ctx) {
    const continuedPlanTurns = new Map<string, string>();
    const getConfig = () => loadConfig(ctx.workspacePath);
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanCreateTool(ctx.workspacePath, getConfig)));
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanUpdateTool(ctx.workspacePath)));
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanReviseTool(ctx.workspacePath, getConfig)));
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanPauseTool(ctx.workspacePath)));
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
        const activePlan = hookCtx.turnId ? findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId) : undefined;
        if (activePlan && activePlan.turnId !== hookCtx.turnId) continuedPlanTurns.set(hookCtx.sessionId, activePlan.turnId);
        const isWaitingForUser = activePlan?.steps.some((step) => step.status === "waiting_user");
        const resumePrompt = activePlan && activePlan.turnId !== hookCtx.turnId
          ? isWaitingForUser
            ? `\n\n当前会话有一个等待用户回复的既有计划。不要调用 plan_create；先调用 plan_update 将步骤 ${activePlan.currentStepId} 恢复为 in_progress，然后根据用户回复继续。`
            : "\n\n当前会话正在继续既有计划。不要调用 plan_create，按既有步骤继续执行。"
          : "";
        return `${prompt}\n\n${PLAN_PROMPT}${resumePrompt}`;
      },
      onFilterToolDefinitions(hookCtx, definitions) {
        if (hookCtx.executionMode !== "plan" || !hookCtx.turnId) return definitions;
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        return filterPlanTools(definitions, plan);
      },
      onBeforeModelCall(hookCtx, modelContext) {
        if (hookCtx.executionMode !== "plan" || !hookCtx.turnId || !modelContext.reportStatus) return;
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        reportPlanStatus(modelContext.reportStatus, plan);
      },
      onBeforeTool(hookCtx, name) {
        if (hookCtx.executionMode !== "plan" || name === "plan_create" || name === "plan_update" || name === "plan_revise") return;
        if (!hookCtx.turnId) return { abort: "计划模式缺少轮次标识" };
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        if (!plan) return { abort: "计划模式必须先调用 plan_create" };
        const current = plan.steps.find((step) => step.id === plan.currentStepId);
        if (current?.status === "waiting_approval" || current?.status === "waiting_user") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, plan.turnId, "in_progress");
        else if (current?.status !== "in_progress") return { abort: "执行工具前必须调用 plan_update 将当前步骤设为 in_progress" };
      },
      onChatResponse(hookCtx, response) {
        if (hookCtx.executionMode !== "plan" || response.toolCalls.length > 0) return response;
        if (!hookCtx.turnId) return response;
        const continuedTurnId = continuedPlanTurns.get(hookCtx.sessionId);
        let plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId)
          ?? (continuedTurnId ? listSessionPlans(ctx.workspacePath, hookCtx.sessionId).find((item) => item.turnId === continuedTurnId) : undefined);
        if (!plan) return response;
        if (plan?.steps.some((step) => step.status === "waiting_user")) return response;
        if (plan?.status === "completed" || plan?.status === "failed") return response;
        plan = completeFinalPlanStep(ctx.workspacePath, hookCtx.sessionId, plan?.turnId ?? hookCtx.turnId);
        if (plan?.status === "completed") return response;
        return { ...response, text: `计划执行异常：Agent 在全部步骤完成前结束了任务。\n\n${response.text}` };
      },
      onTurnEnd(hookCtx, reason) {
        if (hookCtx.executionMode !== "plan") return;
        if (!hookCtx.turnId) return;
        if (reason === "approval_required") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "waiting_approval");
        if (reason === "iteration_limit") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "failed", "达到 Agent 迭代上限");
        if (reason === "completed") {
          const continuedTurnId = continuedPlanTurns.get(hookCtx.sessionId);
          const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId)
            ?? (continuedTurnId ? listSessionPlans(ctx.workspacePath, hookCtx.sessionId).find((item) => item.turnId === continuedTurnId) : undefined);
          if (plan?.steps.some((step) => step.status === "waiting_user")) return;
          if (plan && plan.status !== "completed" && plan.status !== "failed") failSessionPlan(ctx.workspacePath, hookCtx.sessionId, plan.turnId, "Agent 在计划完成前结束任务");
          continuedPlanTurns.delete(hookCtx.sessionId);
        }
      },
      onError(hookCtx, error) {
        if (hookCtx.executionMode === "plan" && hookCtx.turnId) markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId, "failed", error.message);
      },
    });
  },
};
