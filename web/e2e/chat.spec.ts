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

test("shows a stop button while streaming and cancels the request", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/chat", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: done\ndata: {"text":"","session_id":"session-1"}\n\n',
    }).catch(() => {});
  });

  await page.goto("/");
  await page.getByRole("textbox").fill("long task");
  await page.getByRole("button", { name: "↑" }).click();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("button", { name: "停止" })).not.toBeVisible();
});

test("clears chat and switches session when /new completes", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/chat", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'event: text_delta\ndata: {"text":"已创建新会话：new-sess"}',
        'event: done\ndata: {"text":"已创建新会话：new-sess","session_id":"new-session","clear_messages":true}',
        "",
      ].join("\n\n"),
    });
  });

  await page.goto("/");
  await page.getByRole("textbox").fill("/new");
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.getByText("/new")).not.toBeVisible();
  await expect(page.getByText("已创建新会话：new-sess")).toBeVisible();
  await expect(page).toHaveURL(/sid=new-session/);
});

test("deletes a persisted session and keeps it gone after refresh", async ({ page }) => {
  let sessions = [{ id: "session?special#id", lastActivity: Date.now(), preview: "delete me" }];
  let deletePath = "";

  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions } });
  });
  await page.route("**/sessions/**", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const url = new URL(route.request().url());
    deletePath = url.pathname;
    if (decodeURIComponent(url.pathname.slice("/sessions/".length)) === sessions[0]?.id) {
      sessions = [];
      await route.fulfill({ json: { deleted: true, deletedHistoryRecords: 1 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/");
  await expect(page.getByText("delete me")).toBeVisible();
  await page.locator(".session-item .delete-btn").click();
  await expect(page.getByText("delete me")).not.toBeVisible();

  await page.reload();
  await expect(page.getByText("delete me")).not.toBeVisible();
  expect(deletePath).toBe("/sessions/session%3Fspecial%23id");
});
