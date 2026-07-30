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

test("autocompletes dynamically registered slash commands", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/commands", async (route) => {
    await route.fulfill({
      json: {
        commands: [
          { name: "context", aliases: ["ctx"], description: "显示上下文长度", usage: "/context" },
          { name: "approve", aliases: [], description: "批准命令", usage: "/approve <审批 ID>" },
          { name: "custom", aliases: ["cu"], description: "工作区自定义命令", usage: "/custom [参数]" },
        ],
      },
    });
  });

  await page.goto("/");
  const input = page.getByRole("textbox");
  await input.fill("/");

  const listbox = page.getByRole("listbox", { name: "聊天命令" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(3);

  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("/approve ");

  await input.fill("/cu");
  await expect(listbox.getByRole("option")).toHaveCount(1);
  await input.press("Tab");
  await expect(input).toHaveValue("/custom ");

  await input.fill("/co");
  await listbox.getByRole("option").click();
  await expect(input).toHaveValue("/context");

  await input.fill("/");
  await expect(listbox).toBeVisible();
  await input.press("Escape");
  await expect(listbox).not.toBeVisible();
});

test("uploads, previews, sends, and renders an image attachment", async ({ page }) => {
  let chatBody: Record<string, unknown> | undefined;
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/uploads*", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        json: {
          attachment: {
            id: "image-1",
            name: "screen.png",
            mediaType: "image/png",
            size: 9,
            url: "/uploads?id=image-1&session_id=image-session",
          },
        },
      });
      return;
    }
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    });
  });
  await page.route("**/chat", async (route) => {
    chatBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'event: text_delta\ndata: {"text":"看到了"}',
        'event: done\ndata: {"text":"看到了","session_id":"image-session"}',
        "",
      ].join("\n\n"),
    });
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "screen.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  });
  await expect(page.getByLabel("待发送图片").getByRole("img", { name: "screen.png" })).toBeVisible();
  await page.getByRole("textbox").fill("解释图片");
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.locator(".message.user").getByRole("img", { name: "screen.png" })).toBeVisible();
  await expect(page.getByText("看到了")).toBeVisible();
  expect(chatBody).toMatchObject({
    message: "解释图片",
    attachments: ["image-1"],
  });
  expect(typeof chatBody?.session_id).toBe("string");
});

test("shows processing state immediately after sending", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/chat", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'event: text_delta\ndata: {"text":"收到"}',
        'event: done\ndata: {"text":"收到","session_id":"session-1"}',
        "",
      ].join("\n\n"),
    });
  });

  await page.goto("/");
  await page.getByRole("textbox").fill("hello");
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.getByText("正在处理")).toBeVisible();
  await expect(page.getByText("收到")).toBeVisible();
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
