import type { SessionPlan } from "../types.js";

const STATUS_LABELS = {
  pending: "待执行",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  waiting_approval: "等待审批",
} as const;

export default function PlanProgress({ plan }: { plan: SessionPlan | null | undefined }) {
  if (!plan) return null;
  const completed = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const percent = plan.steps.length > 0 ? Math.round((completed / plan.steps.length) * 100) : 0;
  return (
    <section className={`plan-progress plan-${plan.status}`} aria-label="任务计划进度">
      <div className="plan-progress-header">
        <strong>任务进度</strong>
        <span>{completed} / {plan.steps.length}</span>
      </div>
      <div className="plan-progress-track"><span style={{ width: `${percent}%` }} /></div>
      <div className="plan-step-list">
        {plan.steps.map((step, index) => (
          <div className={`plan-step plan-step-${step.status}`} key={step.id}>
            <span className="plan-step-marker">{step.status === "completed" ? "✓" : step.status === "failed" ? "!" : step.status === "in_progress" || step.status === "waiting_approval" ? "●" : "○"}</span>
            <span className="plan-step-title">{index + 1}. {step.title}</span>
            <span className="plan-step-status">{STATUS_LABELS[step.status]}</span>
            {step.summary && <span className="plan-step-summary">{step.summary}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
