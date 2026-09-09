import { useEffect, useState } from "react";
import type { RunView, SessionPlan } from "../types.js";
import { formatDuration, useElapsedTime } from "../lib/elapsed-time.js";

const STATUS_LABELS = {
  pending: "待执行",
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  waiting_approval: "等待审批",
  waiting_user: "等待用户",
} as const;

function getPlanStatus(plan: SessionPlan): string {
  if (plan.status === "failed") return "失败";
  if (plan.status === "completed") return "已完成";
  if (plan.steps.some((step) => step.status === "waiting_user")) return "等待用户";
  if (plan.steps.some((step) => step.status === "waiting_approval")) return "等待审批";
  if (plan.steps.some((step) => step.status === "in_progress")) return "执行中";
  return "待执行";
}

export default function PlanProgress({ plan, historical = false, onResume, runState, run }: { plan: SessionPlan | null | undefined; historical?: boolean; onResume?: () => void; runState?: string; run?: RunView }) {
  const [expanded, setExpanded] = useState(false);
  const planId = plan?.id;
  const elapsed = useElapsedTime(run?.startedAt, run?.completedAt, run?.state === "running" || run?.state === "waiting_approval");
  const duration = elapsed !== undefined ? <span className="plan-duration">总耗时 {formatDuration(elapsed)}</span> : null;

  useEffect(() => {
    setExpanded(false);
  }, [planId]);

  if (!plan) return null;
  const completed = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const status = runState === "waiting_approval" ? "等待审批" : runState === "running" ? "执行中" : getPlanStatus(plan);
  const currentStepIndex = plan.steps.findIndex((step) => step.id === plan.currentStepId);
  const fallbackStepIndex = plan.steps.findIndex((step) => step.status === "in_progress"
    || step.status === "waiting_approval"
    || step.status === "waiting_user"
    || step.status === "pending");
  const visibleStepIndex = currentStepIndex >= 0 ? currentStepIndex : fallbackStepIndex;
  const currentStep = plan.steps[visibleStepIndex];
  const steps = (
    <div className="plan-step-list">
      {plan.steps.map((step, index) => (
        <div className={`plan-step plan-step-${step.status}`} key={step.id}>
          <span className="plan-step-marker">{step.status === "completed" ? "✓" : step.status === "failed" ? "!" : step.status === "in_progress" || step.status === "waiting_approval" || step.status === "waiting_user" ? "●" : "○"}</span>
          <span className="plan-step-title">{index + 1}. {step.title}</span>
          <span className="plan-step-status">{STATUS_LABELS[step.status]}</span>
          {step.summary && <span className="plan-step-summary">{step.summary}</span>}
        </div>
      ))}
    </div>
  );
  if (historical) {
    const historicalStatus = plan.status === "failed" ? "失败"
      : plan.status === "completed" ? "已完成"
      : runState === "interrupted" ? "已中断"
      : runState === "cancelled" ? "已取消"
      : runState === "waiting_user" ? "等待用户"
      : runState === "waiting_approval" ? "等待审批"
      : "本轮已结束（未完成）";
    return (
      <section className={`plan-progress plan-history plan-${plan.status}`} aria-label="任务计划进度">
        <details key={plan.id}>
          <summary>
            <span>任务记录 · {historicalStatus} {completed} / {plan.steps.length}</span>
            {duration}
            {plan.goal && <span className="plan-history-goal">{plan.goal}</span>}
          </summary>
          {steps}
          {onResume && <button type="button" onClick={onResume}>继续此计划</button>}
        </details>
      </section>
    );
  }
  return (
    <section className={`plan-progress plan-${plan.status}`} aria-label="任务计划进度">
      <button
        type="button"
        className="plan-progress-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <strong>任务计划</strong>
        <span className={`plan-progress-state plan-step-${currentStep?.status ?? "pending"}`}>{status} · {completed} / {plan.steps.length}</span>
        {duration}
        {currentStep && <span className="plan-progress-current">第 {visibleStepIndex + 1} 步：{currentStep.title}</span>}
        <span className="plan-progress-chevron" aria-hidden="true">⌄</span>
      </button>
      {expanded && <div className="plan-progress-details">
        {plan.goal && <div className="plan-goal">
          <strong>当前目标</strong>
          <p>{plan.goal}</p>
        </div>}
        {steps}
      </div>}
    </section>
  );
}
