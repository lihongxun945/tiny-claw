import type { NotificationPayload } from "../types.js";

function supportsNotifications(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** 页面是否处于前台且聚焦。 */
function isInForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export async function ensureNotificationPermission(): Promise<void> {
  if (!supportsNotifications()) return;
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // 用户拒绝或环境不支持时静默忽略，不影响主流程。
    }
  }
}

/**
 * 仅当页面不在前台聚焦时才弹系统通知（后台抑制固定开启）。
 */
export function showBackgroundNotification(payload: NotificationPayload): void {
  if (!supportsNotifications()) return;
  if (Notification.permission !== "granted") return;
  if (isInForeground()) return;
  try {
    const notification = new Notification(payload.title, {
      body: payload.body ?? "",
      tag: `breeze-coder-${payload.turnId ?? payload.sessionId ?? "notification"}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // 某些环境构造 Notification 可能失败，忽略即可。
  }
}
