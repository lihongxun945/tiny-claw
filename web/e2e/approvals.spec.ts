import { expect, test } from "@playwright/test";

const approval = {
  id: "approval-1",
  source: "bash",
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
  await page.route("**/approvals/approval-1/approve", async (route) => {
    await route.fulfill({ json: { approval: { ...approval, status: "approved" } } });
  });

  await page.goto("/");
  await page.locator(".session-id", { hasText: "approval" }).click();

  await expect(page.getByText("此命令需要批准")).toBeVisible();
  await page.getByRole("button", { name: "批准" }).click();
  await expect(page.getByText("已批准。请重新发送原任务，下一次相同命令会执行一次。")).toBeVisible();
});
