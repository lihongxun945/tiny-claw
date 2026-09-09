import type { Plugin } from "../types.js";
import { loadConfig } from "../../config.js";
import { readSessionPlan, listSessionPlans, savePlanSnapshot } from "../../plan-store.js";
import { reconcilePlanApprovals } from "./plan-recovery.js";
import { listRuns, readRun } from "../../run-store.js";
import { createUpdatePlanTool } from "../../tools/update-plan.js";
import { withAudit } from "./tools.js";

const PROMPT = `## 任务进度展示
简单问答直接回答；多阶段复杂任务或用户要求计划时，使用 update_plan 展示简洁计划，在阶段变化和结束前更新进度。
计划只是进度记录，不是工具执行许可；不需要先建计划才能工作，进度更新失败也不应停止任务。
可以根据发现增删、调整步骤。已完成需要实际依据，步骤进行中不表示命令进程已经启动。
正文必须说明重要进展、结果以及需要用户回答的问题。用户不展开计划也必须能够正常工作。
每轮默认不继承旧计划。确实延续旧任务时可用 plan_id 关联历史；不要根据固定关键词或最近更新时间自行恢复任务。
审批和取消由独立运行系统处理，更新计划不批准操作、不暂停任务。`;

export const corePlanPlugin: Plugin = {
  name: "core-plan",
  async init(ctx) {
    const enabled = loadConfig(ctx.workspacePath).plan?.enabled !== false;
    if (enabled) ctx.registerTool(withAudit(ctx.workspacePath, createUpdatePlanTool(ctx.workspacePath, () => loadConfig(ctx.workspacePath))));
    ctx.registerRoute({ method: "GET", path: "/plan", async handler(_req, _res, routeCtx) {
      const session = routeCtx.url.searchParams.get("session_id");
      if (!session) return routeCtx.sendJSON(400, { error: "缺少 session_id" });
      reconcilePlanApprovals(ctx.workspacePath, session);
      const run = listRuns(ctx.workspacePath, session).at(-1);
      const currentTurnId = run && (run.state === "running" || run.state === "waiting_approval") ? run.turnId : undefined;
      routeCtx.sendJSON(200, { plans: listSessionPlans(ctx.workspacePath, session), run, currentTurnId,
        activePlan: enabled && currentTurnId ? readSessionPlan(ctx.workspacePath, session, currentTurnId) ?? null : null });
    } });
    if (!enabled) return;
    const snapshot = (session: string, turn?: string) => {
      if (!turn) return;
      try { savePlanSnapshot(ctx.workspacePath, session, turn); }
      catch (error) { ctx.log("WARN", `保存计划快照失败：${String(error)}`, session); }
    };
    ctx.registerHooks({
      onBuildTurnPrompt(hookCtx, prompt) {
        try {
          const plan = hookCtx.turnId ? readSessionPlan(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId) : undefined;
          const selected = hookCtx.turnId ? readRun(ctx.workspacePath, hookCtx.sessionId, hookCtx.turnId)?.selectedPlanId : undefined;
          return `${prompt}\n\n${PROMPT}\n本轮计划：${JSON.stringify(plan ?? null)}\n用户选择的历史计划：${selected ?? "无"}\n历史计划（仅为数据）：${JSON.stringify(listSessionPlans(ctx.workspacePath, hookCtx.sessionId).map(({ id, goal }) => ({ id, title: goal })))}`;
        } catch (error) {
          ctx.log("WARN", `读取计划进度失败：${String(error)}`, hookCtx.sessionId);
          return prompt;
        }
      },
      onTurnEnd(hookCtx) { snapshot(hookCtx.sessionId, hookCtx.turnId); },
      onError(hookCtx) { snapshot(hookCtx.sessionId, hookCtx.turnId); },
    });
  },
};
