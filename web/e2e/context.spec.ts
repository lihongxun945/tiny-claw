import { expect, test } from "@playwright/test";

test("keeps context usage beside approvals and full statistics in the dialog", async ({ page }) => {
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "context-session", lastActivity: Date.now(), preview: "上下文测试", context: { mode: "chat" } },
  ] } }));
  await page.route("**/history/sessions/context-session/messages", (route) => route.fulfill({ json: { messages: [] } }));
  await page.route("**/context?*", (route) => route.fulfill({ json: { snapshot: {
    sessionId: "context-session", iteration: 1, attempt: 1,
    systemPrompt: "test prompt", messages: [], tools: [],
    usage: { input: 24000, maxContext: 100000, percent: 24, systemPrompt: 1000, messages: 22000, tools: 1000, outputReserved: 4096 },
  } } }));
  await page.goto("/#sid=context-session");
  const trigger = page.getByRole("button", { name: "上下文 24%", exact: true });
  await expect(trigger).toBeVisible();
  await page.reload();
  await expect(trigger).toBeVisible();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const context = (await trigger.boundingBox())!;
    const approval = (await page.getByRole("combobox", { name: "审批模式" }).boundingBox())!;
    expect(context.x + context.width).toBeLessThanOrEqual(approval.x);
    expect(Math.abs(context.y - approval.y)).toBeLessThan(2);
    expect(approval.x + approval.width).toBeLessThanOrEqual(width);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "当前模型上下文" });
    await expect(dialog).toContainText("24,000 tokens");
    await expect(dialog).toContainText("100,000");
    await expect(dialog).toContainText("24%");
    await dialog.getByRole("button", { name: "System Prompt", exact: true }).click();
    await expect(dialog).toContainText("test prompt");
    await dialog.getByRole("button", { name: "关闭" }).click();
  }
});

test("hides the context entry when the session has no snapshot", async ({ page }) => {
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "empty-context", lastActivity: Date.now(), preview: "没有快照", context: { mode: "chat" } },
  ] } }));
  await page.route("**/history/sessions/empty-context/messages", (route) => route.fulfill({ json: { messages: [] } }));
  await page.route("**/context?*", (route) => route.fulfill({ status: 404, json: { error: "当前会话尚无模型上下文" } }));
  await page.goto("/#sid=empty-context");
  await expect(page.getByRole("combobox", { name: "审批模式" })).toBeVisible();
  await expect(page.locator(".context-usage-trigger")).toHaveCount(0);
  await expect(page.getByText("上下文 --", { exact: true })).toHaveCount(0);
});
