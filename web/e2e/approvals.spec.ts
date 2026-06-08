import { expect, test } from "@playwright/test";

const approval = {
  id: "approval-1",
  toolName: "bash",
  args: { command: "npm test", cwd: "/tmp/workspace" },
  command: "npm test",
  cwd: "/tmp/workspace",
  status: "pending",
  createdAt: "2026-06-02T00:00:00.000Z",
  expiresAt: "2026-06-02T00:10:00.000Z",
};

test("approves a pending command from the chat tool block", async ({ page }) => {
  const result = JSON.stringify({
    error: "bash 执行需要用户确认。",
    requiresConfirmation: true,
    approvalId: "approval-1",
    command: "npm test",
    cwd: "/tmp/workspace",
  });

  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [{ id: "approval-chat", lastActivity: Date.now(), preview: "approval" }],
      },
    });
  });
  await page.route("**/history/sessions/approval-chat/messages", async (route) => {
    await route.fulfill({
      json: {
        messages: [{
          role: "assistant",
          text: "",
          toolCalls: [{
            name: "bash",
            input: { command: "npm test" },
            result,
          }],
          timestamp: Date.now(),
        }],
      },
    });
  });
  await page.route("**/approvals/approval-1/approve-and-resume", async (route) => {
    await route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: [
        "event: tool_call",
        "data: {\"name\":\"bash\",\"input\":{\"command\":\"npm test\"}}",
        "",
        "event: tool_result",
        "data: {\"name\":\"bash\",\"result\":\"{\\\"stdout\\\":\\\"approved output\\\",\\\"stderr\\\":\\\"\\\",\\\"exitCode\\\":0}\"}",
        "",
        "event: text_delta",
        "data: {\"text\":\"继续完成\"}",
        "",
        "event: done",
        "data: {\"text\":\"继续完成\",\"session_id\":\"approval-chat\"}",
        "",
        "",
      ].join("\n"),
    });
  });

  await page.goto("/");
  await page.locator(".session-id", { hasText: "approval" }).click();

  await expect(page.getByText("此工具调用需要批准")).toBeVisible();
  await page.getByRole("button", { name: "批准" }).click();
  await expect(page.getByText("已批准，并已继续执行原任务。")).toBeVisible();
  await expect(page.getByText("approved output", { exact: true })).toBeVisible();
  await expect(page.getByText("继续完成")).toBeVisible();
});
