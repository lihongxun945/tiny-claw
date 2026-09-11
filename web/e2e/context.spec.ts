import { expect, test } from "@playwright/test";

test("distinguishes a rejected estimate from the preceding request after reload", async ({ page }) => {
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [{ id: "estimate", lastActivity: Date.now(), preview: "预算", context: { mode: "chat" } }] } }));
  await page.route("**/history/sessions/estimate/messages", route => route.fulfill({ json: { messages: [] } }));
  await page.route("**/context?*", route => route.fulfill({ json: { snapshot: {
    sessionId: "estimate", kind: "estimate", iteration: 2, attempt: 1, systemPrompt: "", messages: [], tools: [],
    usage: { input: 176000, maxContext: 128000, percent: 100, systemPrompt: 9000, messages: 167000, tools: 0, outputReserved: 16000 },
    lastRequest: { createdAt: "2026-09-11T06:17:31Z", usage: { percent: 29 } },
  } } }));
  await page.goto("/#sid=estimate");
  await page.reload();
  await page.getByRole("button", { name: "上下文 100%", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "当前模型上下文" });
  await expect(dialog).toContainText("最新预算估算（未发送）");
  await expect(dialog).toContainText("上次请求占用");
  await expect(dialog).toContainText("29%");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/context-estimate-${width}.png` });
  }
});

test("keeps context usage beside approvals and full statistics in the dialog", async ({ page }) => {
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "context-session", lastActivity: Date.now(), preview: "上下文测试", context: { mode: "chat" } },
  ] } }));
  await page.route("**/history/sessions/context-session/messages", (route) => route.fulfill({ json: { messages: [] } }));
  await page.route("**/context?*", (route) => route.fulfill({ json: { snapshot: {
    sessionId: "context-session", iteration: 1, attempt: 1,
    systemPrompt: "test prompt", messages: [{ role: "assistant", content: "request-time summary" }], tools: [],
    contextSummaries: [{ title: "会话摘要", content: "request-time summary" }, { title: "临时压缩摘要", content: "temporary summary" }],
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
    await dialog.getByRole("button", { name: "上下文摘要", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "会话摘要", exact: true })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "临时压缩摘要", exact: true })).toBeVisible();
    await expect(dialog.locator("pre")).toHaveText(["request-time summary", "temporary summary"]);
    for (const button of await dialog.locator("nav button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await dialog.getByRole("button", { name: "Messages", exact: true }).click();
    await expect(dialog.locator("pre")).toContainText("request-time summary");
    await dialog.getByRole("button", { name: "关闭" }).click();
  }
});

for (const legacy of [false, true]) {
  test(`distinguishes absent summaries from legacy snapshots (legacy=${legacy})`, async ({ page }) => {
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
      { id: "context-empty", lastActivity: Date.now(), preview: "摘要测试", context: { mode: "chat" } },
    ] } }));
    await page.route("**/history/sessions/context-empty/messages", (route) => route.fulfill({ json: { messages: [] } }));
    await page.route("**/context?*", (route) => route.fulfill({ json: { snapshot: {
      sessionId: "context-empty", iteration: 1, attempt: 1, systemPrompt: "", messages: [], tools: [],
      ...(legacy ? {} : { contextSummaries: [] }),
      usage: { input: 1, maxContext: 100, percent: 1, systemPrompt: 1, messages: 0, tools: 0, outputReserved: 0 },
    } } }));
    await page.goto("/#sid=context-empty");
    await page.getByRole("button", { name: "上下文 1%", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "当前模型上下文" });
    await dialog.getByRole("button", { name: "上下文摘要", exact: true }).click();
    await expect(dialog).toContainText(legacy ? "该快照未单独记录上下文摘要" : "本次调用未使用上下文摘要");
  });
}

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
