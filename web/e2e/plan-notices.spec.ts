import { test, expect } from "@playwright/test";

for (const state of ["waiting_user", "interrupted"]) {
  test(`shows ${state} in the message with the plan closed after reload`, async ({ page }) => {
    const text = state === "waiting_user" ? "等待您的回复：请选择 A 小样本或 B 完整评测。" : "本轮已中断：未建立可执行计划。被拦截的操作没有执行。";
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [{ id: "notice", context: { mode: "chat" }, lastActivity: Date.now(), executionMode: "plan" }] } }));
    await page.route("**/history/sessions/notice/messages", (route) => route.fulfill({ json: { messages: [{
      role: "assistant", text, toolCalls: [], timestamp: Date.now(), turnId: "turn", runState: state,
      plan: { id: "plan", turnId: "turn", status: "executing", goal: "评测", createdAt: "", updatedAt: "", steps: [{ id: "step-1", title: "运行评测", status: "waiting_user", summary: "旧步骤说明" }] },
    }] } }));
    await page.goto("/#sid=notice");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.locator(".plan-history details")).not.toHaveAttribute("open", "");
      await expect(page.locator(".plan-step-list")).not.toBeVisible();
      await expect(page.locator(".plan-history summary")).toContainText(state === "interrupted" ? "已中断" : "等待用户");
      if (attempt === 0) await page.reload();
    }
  });
}
