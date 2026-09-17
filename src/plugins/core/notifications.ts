import type { Plugin, NotificationPayload, TurnEndReason } from "../types.js";

const DEFAULT_REASONS: TurnEndReason[] = ["approval_required", "waiting_user", "completed", "iteration_limit"];

const NOTIFICATION_TEXT: Partial<Record<TurnEndReason, { title: string; body: string }>> = {
  completed: { title: "本轮完成", body: "皮皮虾已完成本轮任务，可回来查看结果" },
  approval_required: { title: "需要你的审批", body: "皮皮虾已暂停，等待你批准后继续执行" },
  waiting_user: { title: "等待你的输入", body: "皮皮虾已暂停，等待你的回答" },
  iteration_limit: { title: "已达迭代上限", body: "皮皮虾本轮已自动停止，可继续追问" },
};

interface NotificationSettings {
  enabled?: boolean;
  reasons?: string[];
}

/** 纯函数：根据触发原因和配置决定是否通知，以及通知标题/正文。便于单测。 */
export function resolveNotification(
  reason: TurnEndReason,
  settings?: NotificationSettings,
): { title: string; body: string } | undefined {
  if (settings?.enabled === false) return undefined;
  const reasons = settings?.reasons?.length ? settings.reasons : DEFAULT_REASONS;
  if (!reasons.includes(reason)) return undefined;
  return NOTIFICATION_TEXT[reason];
}

export const coreNotificationsPlugin: Plugin = {
  name: "core-notifications",
  async init(ctx) {
    ctx.registerHooks({
      onTurnEnd(hookCtx, reason) {
        const template = resolveNotification(reason, hookCtx.config.notifications);
        if (!template) return;
        const payload: NotificationPayload = {
          ...template,
          sessionId: hookCtx.sessionId,
          turnId: hookCtx.turnId,
        };
        return payload;
      },
    });
  },
};
