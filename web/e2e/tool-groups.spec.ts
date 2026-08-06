import { expect, test } from "@playwright/test";

async function mockSession(page: import("@playwright/test").Page, toolCalls: Array<Record<string, unknown>>) {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [{ id: "tool-group-chat", lastActivity: Date.now(), preview: "tools", context: { mode: "chat" } }] } });
  });
  await page.route("**/history/sessions/tool-group-chat/messages", async (route) => {
    await route.fulfill({ json: { messages: [{ role: "assistant", text: "任务完成", toolCalls, timestamp: Date.now() }] } });
  });
}

test("collapses completed tool calls into a scrollable summary", async ({ page }) => {
  await mockSession(page, Array.from({ length: 12 }, (_, index) => ({
    id: `call-${index}`,
    name: index < 10 ? "file_read" : "web_search",
    input: index < 10 ? { path: `/tmp/file-${index}.ts` } : { query: `query-${index}` },
    result: index === 11 ? JSON.stringify({ error: "search failed" }) : JSON.stringify({ content: `result-${index}` }),
  })));

  await page.goto("/");
  await page.locator(".session-item", { hasText: "tools" }).click();

  const header = page.locator(".tool-call-group-header");
  await expect(header).toContainText("12 次调用");
  await expect(header).toContainText("11 成功");
  await expect(header).toContainText("1 失败");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".tool-block")).toHaveCount(0);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".tool-block")).toHaveCount(12);
  const list = page.locator(".tool-call-group-list");
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test("keeps a tool group expanded while an approval is pending", async ({ page }) => {
  const approvalResult = JSON.stringify({
    error: "bash 执行需要用户确认。",
    requiresConfirmation: true,
    approvalId: "approval-group-1",
    command: "npm test",
  });
  await mockSession(page, [{
    id: "call-complete",
    name: "file_read",
    input: { path: "/tmp/package.json" },
    result: JSON.stringify({ content: "{}" }),
  }, {
    id: "call-approval",
    name: "bash",
    input: { command: "npm test" },
    result: approvalResult,
  }]);

  await page.goto("/");
  await page.locator(".session-item", { hasText: "tools" }).click();

  const header = page.locator(".tool-call-group-header");
  await expect(header).toContainText("1 待审批");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("此工具调用需要批准")).toBeVisible();

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "批准本次" })).toBeVisible();
});
