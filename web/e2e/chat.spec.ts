import { expect, test } from "@playwright/test";

test("renders markdown tables from persisted messages", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [{ id: "session-1", lastActivity: Date.now(), preview: "table" }],
      },
    });
  });
  await page.route("**/history/sessions/session-1/messages", async (route) => {
    await route.fulfill({
      json: {
        messages: [{
          role: "assistant",
          text: "| 名称 | 用途 |\n| --- | --- |\n| web_search | 网络搜索 |",
          toolCalls: [],
          timestamp: Date.now(),
        }],
      },
    });
  });

  await page.goto("/");
  await page.getByText("session-").click();

  const table = page.locator(".markdown-table-wrap table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("cell", { name: "名称" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "web_search" })).toBeVisible();
});
