import type { ModelCallContext, Plugin } from "../types.js";
import type { ToolDefinition } from "../../types.js";
import { loadConfig } from "../../config.js";
import { completeFinalPlanStep, failSessionPlan, findActiveSessionPlan, listSessionPlans, markCurrentPlanStep } from "../../plan-store.js";
import { createPlanCreateTool, createPlanPauseTool, createPlanResumeTool, createPlanReviseTool, createPlanUpdateTool } from "../../tools/plan.js";
import { withAudit } from "./tools.js";

const PLAN_PROMPT = `## 计划执行模式
如果用户问题无需调用任何工具就能准确回答，可以直接回答，不要创建计划。
创建计划前可以调用只读工具收集制定可靠计划所必需的信息，但禁止调用任何写入或有副作用的工具，也不要为了完善计划而无限调研。
如果完成必要侦察后任务仍需要写入或有副作用的工具，必须先调用 plan_create 创建 2 到配置上限个基于事实、可验证的步骤。
创建计划时必须同时提供 goal，简洁描述用户期望的最终结果，不要用第一步或执行状态代替目标。调整步骤和恢复计划时保留原目标；用户提出不同目标时创建新计划。
执行每一步前调用 plan_update 将其设为 in_progress；完成后设为 completed 并写简短 summary。
调研完成后调用 plan_revise，将全部尚未执行的步骤替换为基于调研结果的具体步骤，再继续执行。
同一时间只能有一个执行中步骤，必须按顺序执行。不得披露内部推理，只描述可观察的目标和结果。
需要用户确认或补充信息时，先清晰输出待确认内容，再调用 plan_pause 暂停。
每轮独立判断用户意图。仅当用户明确继续旧任务时，调用 plan_resume 绑定对应计划，再用 plan_update 开始步骤；无关问答直接回答，新任务调用 plan_create。多个旧任务指代不清时先询问用户。
所有步骤完成后才能输出最终总结；发现失败时将当前步骤设为 failed。`;

function filterPlanTools(
  definitions: ToolDefinition[],
  plan: ReturnType<typeof findActiveSessionPlan>,
  isReadOnly: (name: string) => boolean,
): ToolDefinition[] {
  if (!plan) return definitions.filter((definition) => definition.name === "plan_create" || definition.name === "plan_resume" || isReadOnly(definition.name));
  if (plan.status === "completed" || plan.status === "failed") return [];
  const current = plan.steps.find((step) => step.id === plan.currentStepId);
  if (current?.status === "in_progress") {
    return definitions.filter((definition) => definition.name !== "plan_create" && definition.name !== "plan_resume");
  }
  return definitions.filter((definition) => definition.name === "plan_update" || definition.name === "plan_revise" || isReadOnly(definition.name));
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
    const currentTurns = new Map<string, string>();
    const getConfig = () => loadConfig(ctx.workspacePath);
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanCreateTool(ctx.workspacePath, getConfig)));
    ctx.registerTool(withAudit(ctx.workspacePath, createPlanResumeTool(ctx.workspacePath)));
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
        const currentTurnId = currentTurns.get(sessionId);
        const plan = currentTurnId ? findActiveSessionPlan(ctx.workspacePath, sessionId, currentTurnId) : undefined;
        const activePlan = plan && (plan.status === "planning" || plan.status === "executing")
          && !plan.steps.some((step) => step.status === "waiting_user") ? plan : null;
        routeCtx.sendJSON(200, { plans, currentTurnId, activePlan });
      },
    });
    ctx.registerHooks({
      onBeforeChat(hookCtx) {
        currentTurns.delete(hookCtx.sessionId);
      },
      onBuildTurnPrompt(hookCtx, prompt) {
        if (hookCtx.executionMode !== "plan") return prompt;
        if (hookCtx.turnId) currentTurns.set(hookCtx.sessionId, hookCtx.turnId);
        const candidates = listSessionPlans(ctx.workspacePath, hookCtx.sessionId)
          .filter((plan) => plan.status === "planning" || plan.status === "executing")
          .map((plan) => ({ id: plan.id, goal: plan.goal, steps: plan.steps }));
        return `${prompt}\n\n${PLAN_PROMPT}\n\n可恢复计划（仅供判断用户是否继续，不表示本轮已继承）：${JSON.stringify(candidates)}`;
      },
      onFilterToolDefinitions(hookCtx, definitions) {
        if (hookCtx.executionMode !== "plan" || !hookCtx.turnId) return definitions;
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        return filterPlanTools(definitions, plan, (name) => hookCtx.getTool(name)?.effect === "read");
      },
      onBeforeModelCall(hookCtx, modelContext) {
        if (hookCtx.executionMode !== "plan" || !hookCtx.turnId || !modelContext.reportStatus) return;
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        reportPlanStatus(modelContext.reportStatus, plan);
      },
      onBeforeTool(hookCtx, name) {
        if (hookCtx.executionMode !== "plan" || name === "plan_create" || name === "plan_resume" || name === "plan_update" || name === "plan_revise") return;
        if (!hookCtx.turnId) return { abort: "计划模式缺少轮次标识" };
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        const isReadOnly = hookCtx.getTool(name)?.effect === "read";
        if (!plan && isReadOnly) return;
        if (!plan) return { abort: "计划模式执行写入或有副作用的工具前必须先调用 plan_create" };
        const current = plan.steps.find((step) => step.id === plan.currentStepId);
        if (isReadOnly && current?.status !== "in_progress") return;
        if (current?.status === "waiting_approval" || current?.status === "waiting_user") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, plan.turnId, "in_progress");
        else if (current?.status !== "in_progress") return { abort: "执行工具前必须调用 plan_update 将当前步骤设为 in_progress" };
      },
      onChatResponse(hookCtx, response) {
        if (hookCtx.executionMode !== "plan" || response.toolCalls.length > 0) return response;
        if (!hookCtx.turnId) return response;
        let plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
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
        if (reason !== "approval_required") currentTurns.delete(hookCtx.sessionId);
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        if (!plan) return;
        if (reason === "approval_required") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, plan.turnId, "waiting_approval");
        if (reason === "iteration_limit") markCurrentPlanStep(ctx.workspacePath, hookCtx.sessionId, plan.turnId, "failed", "达到 Agent 迭代上限");
        if (reason === "completed") {
          if (plan?.steps.some((step) => step.status === "waiting_user")) return;
          if (plan && plan.status !== "completed" && plan.status !== "failed") failSessionPlan(ctx.workspacePath, hookCtx.sessionId, plan.turnId, "Agent 在计划完成前结束任务");
        }
      },
      onError(hookCtx, error) {
        currentTurns.delete(hookCtx.sessionId);
        if (hookCtx.executionMode !== "plan" || !hookCtx.turnId) return;
        const plan = findActiveSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId);
        if (plan && plan.status !== "completed" && plan.status !== "failed") failSessionPlan(ctx.workspacePath, hookCtx.sessionId, plan.turnId, error.message);
      },
    });
  },
};
