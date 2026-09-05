import type { SessionPlan } from "../types.js";

const STATUS_LABELS = {
  pending: "待执行",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  waiting_approval: "等待审批",
  waiting_user: "等待用户",
} as const;

export default function PlanProgress({ plan, historical = false }: { plan: SessionPlan | null | undefined; historical?: boolean }) {
  if (!plan) return null;
  const completed = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const percent = plan.steps.length > 0 ? Math.round((completed / plan.steps.length) * 100) : 0;
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
    const status = plan.status === "failed" ? "失败"
      : plan.status === "completed" ? "已完成"
      : plan.steps.some((step) => step.status === "waiting_user") ? "等待用户"
      : plan.steps.some((step) => step.status === "waiting_approval") ? "等待审批"
      : plan.status === "planning" ? "待执行" : "未完成";
    return (
      <section className={`plan-progress plan-history plan-${plan.status}`} aria-label="任务计划进度">
        <details key={plan.id}>
          <summary>
            <span>任务记录 · {status} {completed} / {plan.steps.length}</span>
            {plan.goal && <span className="plan-history-goal">{plan.goal}</span>}
          </summary>
          {steps}
        </details>
      </section>
    );
  }
  return (
    <section className={`plan-progress plan-${plan.status}`} aria-label="任务计划进度">
      {plan.goal && <div className="plan-goal">
        <strong>当前目标</strong>
        <p>{plan.goal}</p>
      </div>}
      <div className="plan-progress-header">
        <strong>任务进度</strong>
        <span>{completed} / {plan.steps.length}</span>
      </div>
      <div className="plan-progress-track"><span style={{ width: `${percent}%` }} /></div>
      {steps}
    </section>
  );
}
