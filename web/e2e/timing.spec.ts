import { expect, test } from "@playwright/test";

const time = Date.parse("2026-09-09T08:00:00Z");
const plan = { id: "timed-plan", turnId: "timed-turn", status: "executing", goal: "验证时间显示", createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), steps: [{ id: "step", title: "运行评测", status: "in_progress" }] };

test("tool elapsed time catches up on focus and stays fixed after completion and reload", async ({ page }) => {
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  let completed = false;
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [{ id: "timing", preview: "timing", lastActivity: time, context: { mode: "chat" } }] } }));
  await page.route("**/history/sessions/timing/messages", route => route.fulfill({ json: { messages: [{
    role: "assistant", text: "运行评测", timestamp: time, turnId: plan.turnId,
    toolCalls: [{ id: "timed-tool", name: "bash", input: { command: "npm test" }, startedAt: time - 12000,
      ...(completed ? { result: '{"stdout":"done"}', completedAt: time + 300000 } : { status: "running" }) }],
    ...(completed ? { plan, run: { state: "completed", startedAt: time - 60000, completedAt: time + 300000 } } : {}),
  }] } }));
  await page.goto("/#sid=timing");
  await expect(page.locator(".tool-status")).toContainText("12s");
  await page.clock.setSystemTime(time + 300000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tool-status")).toHaveText("执行中 · 5m 12s");
  completed = true;
  await page.reload();
  await expect(page.locator(".tool-status")).toHaveText("成功 · 5m 12s");
  await expect(page.locator(".plan-duration")).toHaveText("总耗时 6m 0s");
  await page.clock.setSystemTime(time + 600000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".tool-status")).toHaveText("成功 · 5m 12s");
  await expect(page.locator(".plan-duration")).toHaveText("总耗时 6m 0s");
});

test("collapsed active plan shows total time including approval waits on desktop and mobile", async ({ page }) => {
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  const run = { id: "timed-run", turnId: plan.turnId, revision: 1, state: "waiting_approval", startedAt: time - 120000 };
  const session = { id: "plan-timing", preview: "plan timing", lastActivity: time, context: { mode: "chat" }, attention: "approval" };
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [session] } }));
  await page.route("**/sessions", route => route.fulfill({ json: { sessions: [session] } }));
  await page.route("**/history/sessions/plan-timing/messages", route => route.fulfill({ json: { messages: [] } }));
  await page.route("**/plan?*", route => route.fulfill({ json: { plans: [plan], activePlan: plan, currentTurnId: plan.turnId, run } }));
  await page.goto("/#sid=plan-timing");
  await expect(page.locator(".plan-progress-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".plan-duration")).toHaveText("总耗时 2m 0s");
  await page.clock.setSystemTime(time + 3600000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".plan-duration")).toHaveText("总耗时 1h 2m 0s");
  await page.locator(".plan-progress-toggle").click();
  await expect(page.locator(".plan-duration")).toBeVisible();
  await page.screenshot({ path: "/tmp/timing-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".plan-duration")).toBeVisible();
  expect(await page.locator(".plan-progress").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/timing-mobile.png", animations: "disabled" });
});
