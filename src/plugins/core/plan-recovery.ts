import { listSessionPlans, markCurrentPlanStep } from "../../plan-store.js";
import { listSessionApprovalContinuations } from "../../tools/approval.js";
import { listRuns, updateRun } from "../../run-store.js";

export function reconcilePlanApprovals(workspacePath: string, sessionId: string): void {
  const continuations = listSessionApprovalContinuations(workspacePath, sessionId);
  const turns = new Set(continuations.map(({ continuation }) => continuation.turnId));
  for (const run of listRuns(workspacePath, sessionId)) {
    if (run.state === "waiting_approval" && !continuations.some(({ approval }) => approval.id === run.approvalId)) {
      updateRun(workspacePath, sessionId, run.turnId, { state: "interrupted", reason: "审批已过期或丢失，请核实操作结果后重新发起", approvalId: undefined });
    }
  }
  // Legacy plans stored approval state on the step itself.
  for (const plan of listSessionPlans(workspacePath, sessionId)) {
    if (plan.steps.some((step) => step.status === "waiting_approval")
      && ![plan.turnId, ...(plan.relatedTurnIds ?? [])].some((turnId) => turns.has(turnId))) {
      markCurrentPlanStep(workspacePath, sessionId, plan.turnId, "waiting_user", "审批上下文已过期或丢失，请继续任务后重新发起审批");
    }
  }
}
