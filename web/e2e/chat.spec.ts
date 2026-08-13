import { expect, test } from "@playwright/test";

test("persists the approval mode from the chat composer", async ({ page }) => {
  let config: Record<string, unknown> = {
    security: { mode: "auto", tools: {} },
    project: { security: { mode: "auto", tools: {} } },
  };
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/config", async (route) => {
    if (route.request().method() === "PUT") {
      config = route.request().postDataJSON() as Record<string, unknown>;
    }
    await route.fulfill({ json: { config } });
  });

  await page.goto("/");
  const permissionSelect = page.getByRole("combobox", { name: "审批模式" });
  await expect(permissionSelect).toHaveValue("auto");
  await permissionSelect.selectOption("ask");

  await expect.poll(() => (config.security as { mode?: string }).mode).toBe("ask");
  await expect(permissionSelect).toHaveValue("ask");
  await expect(permissionSelect.locator("option")).toHaveCount(3);
});

test("renders markdown tables from persisted messages", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [{ id: "session-1", lastActivity: Date.now(), preview: "table", context: { mode: "chat" } }],
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

test("uses the authoritative text from the done event when deltas are missing", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/chat", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: done\ndata: {"text":"完整最终回答","session_id":"done-text-session"}\n\n',
    });
  });

  await page.goto("/");
  await page.getByRole("textbox").fill("测试完整结果");
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.getByText("完整最终回答")).toBeVisible();
});

test("recovers a persisted final answer when the SSE stream closes early", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/history/sessions/*/messages", async (route) => {
    await route.fulfill({
      json: {
        messages: [
          { role: "user", text: "需要搜索的问题", toolCalls: [], timestamp: Date.now() - 1 },
          { role: "assistant", text: "从持久化历史恢复的回答", toolCalls: [], timestamp: Date.now() },
        ],
      },
    });
  });
  await page.route("**/chat", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'event: tool_call\ndata: {"name":"web_search","input":{"query":"test"}}',
        'event: tool_result\ndata: {"name":"web_search","result":"ok"}',
        "",
      ].join("\n\n"),
    });
  });

  await page.goto("/");
  await page.getByRole("textbox").fill("需要搜索的问题");
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.getByText("从持久化历史恢复的回答")).toBeVisible();
  await expect(page.getByText(/连接失败/)).toHaveCount(0);
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

  await input.dispatchEvent("compositionstart", { data: "" });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(input).toHaveValue("/");
  await expect(listbox).toBeVisible();
  await input.dispatchEvent("compositionend", { data: "" });

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

test("shows structured model request data in the debug log view", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/logs", async (route) => {
    await route.fulfill({ json: { files: [] } });
  });
  await page.route("**/debug/model-calls?id=request-1", async (route) => {
    await route.fulfill({
      json: {
        trace: {
          requestId: "request-1",
          sessionId: "session-1",
          provider: "openai-chat",
          model: "gpt-test",
          mode: "chat",
          startedAt: "2026-07-31T12:00:00.000Z",
          updatedAt: "2026-07-31T12:00:01.000Z",
          durationMs: 1000,
          status: "success",
          events: [{
            timestamp: "2026-07-31T12:00:00.000Z",
            phase: "request",
            data: { body: { model: "gpt-test", messages: [{ role: "user", content: "原始问题" }] } },
          }, {
            timestamp: "2026-07-31T12:00:00.500Z",
            phase: "stream_event",
            data: { choices: [{ delta: { content: "分片内容" } }] },
          }, {
            timestamp: "2026-07-31T12:00:01.000Z",
            phase: "parsed_response",
            data: { text: "完整最终回复", toolCalls: [] },
          }],
        },
      },
    });
  });
  await page.route("**/debug/model-calls", async (route) => {
    await route.fulfill({
      json: {
        traces: [{
          requestId: "request-1",
          sessionId: "session-1",
          provider: "openai-chat",
          model: "gpt-test",
          mode: "chat",
          startedAt: "2026-07-31T12:00:00.000Z",
          updatedAt: "2026-07-31T12:00:01.000Z",
          durationMs: 1000,
          status: "success",
          eventCount: 1,
        }],
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "日志" }).click();
  await page.getByRole("button", { name: "模型调用" }).click();

  await expect(page.getByRole("button", { name: /gpt-test openai-chat/ })).toBeVisible();
  await expect(page.locator(".model-event-json")).toContainText("原始问题");
  await expect(page.getByRole("button", { name: "请求原文" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最终回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "流事件" })).toHaveCount(0);
  await page.getByRole("button", { name: "最终回复" }).click();
  await expect(page.locator(".model-event-json")).toContainText("完整最终回复");
  await expect(page.locator(".model-event-json")).not.toContainText("分片内容");
  await expect(page.getByRole("button", { name: "复制 JSON" })).toBeVisible();
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

test("previews message images in a lightbox and navigates within the message", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [{ id: "gallery-session", lastActivity: Date.now(), preview: "两张图片", context: { mode: "chat" } }],
      },
    });
  });
  await page.route("**/history/sessions/gallery-session/messages", async (route) => {
    await route.fulfill({
      json: {
        messages: [{
          role: "user",
          text: "两张图片",
          toolCalls: [],
          attachments: [
            { id: "first", name: "first.png", mediaType: "image/png", url: "/uploads?id=first" },
            { id: "second", name: "second.png", mediaType: "image/png", url: "/uploads?id=second" },
          ],
          timestamp: Date.now(),
        }],
      },
    });
  });
  await page.route("**/uploads*", async (route) => {
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    });
  });

  await page.goto("/");
  await page.getByText("gallery-").click();

  const message = page.locator(".message.user");
  await expect(message.locator("a")).toHaveCount(0);
  await message.getByRole("button", { name: "预览 first.png" }).click();

  const dialog = page.getByRole("dialog", { name: "图片预览" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("1 / 2")).toBeVisible();

  await dialog.getByRole("button", { name: "下一张图片" }).click();
  await expect(dialog.getByText("2 / 2")).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByText("1 / 2")).toBeVisible();

  await dialog.locator(".image-lightbox-viewport").dispatchEvent("pointerdown", {
    pointerId: 1,
    clientX: 300,
  });
  await dialog.locator(".image-lightbox-viewport").dispatchEvent("pointerup", {
    pointerId: 1,
    clientX: 200,
  });
  await expect(dialog.getByText("2 / 2")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
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

test("keeps a session running while switching to another conversation", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [
          { id: "session-a", lastActivity: Date.now(), preview: "后台任务", context: { mode: "chat" } },
          { id: "session-b", lastActivity: Date.now() - 1, preview: "其他会话", context: { mode: "chat" } },
        ],
      },
    });
  });
  await page.route("**/history/sessions/*/messages", async (route) => {
    await route.fulfill({ json: { messages: [] } });
  });
  await page.route("**/chat", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'event: text_delta\ndata: {"text":"后台完成"}',
        'event: done\ndata: {"text":"后台完成","session_id":"session-a"}',
        "",
      ].join("\n\n"),
    });
  });

  await page.goto("/");
  await page.getByText("后台任务").click();
  await page.getByRole("textbox").fill("执行耗时任务");
  await page.getByRole("button", { name: "↑" }).click();
  await expect(page.getByText("正在处理")).toBeVisible();

  await page.getByText("其他会话").click();
  await expect(page.getByText("正在处理")).not.toBeVisible();
  await page.getByText("后台任务").click();
  await expect(page.getByText("正在处理")).toBeVisible();
  await expect(page.getByText("后台完成")).toBeVisible();
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
  let sessions = [{ id: "session?special#id", lastActivity: Date.now(), preview: "delete me", context: { mode: "chat" } }];
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

test("sends plan execution mode and restores structured progress", async ({ page }) => {
  let requestedMode = "";
  let sessionId = "";
  const plan = {
    id: "plan-1",
    turnId: "",
    status: "executing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStepId: "step-2",
    steps: [
      { id: "step-1", title: "分析现有实现", status: "completed", summary: "分析完成" },
      { id: "step-2", title: "修改代码", status: "in_progress" },
      { id: "step-3", title: "运行测试", status: "pending" },
    ],
  };
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/commands", async (route) => route.fulfill({ json: { commands: [] } }));
  await page.route("**/plan?*", async (route) => route.fulfill({ json: { plans: [plan] } }));
  await page.route("**/chat", async (route) => {
    const body = route.request().postDataJSON() as { execution_mode?: string; session_id?: string; turn_id?: string };
    requestedMode = body.execution_mode ?? "";
    sessionId = body.session_id ?? "";
    plan.turnId = body.turn_id ?? "";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: tool_call\ndata: ${JSON.stringify({ tool_call_id: "tool-1", name: "plan_create", input: { steps: plan.steps.map((step) => step.title) } })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({ tool_call_id: "tool-1", name: "plan_create", result: JSON.stringify({ plan }) })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ text: "正在按计划执行", session_id: body.session_id, reason: "completed" })}\n\n`,
      ].join(""),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.locator("textarea").fill("实现计划模式");
  await page.locator("textarea").press("Enter");

  await expect.poll(() => requestedMode).toBe("plan");
  await expect.poll(() => sessionId.length > 0).toBe(true);
  await expect(page.getByLabel("任务计划进度")).toBeVisible();
  await expect(page.getByLabel("任务计划进度")).toContainText("1 / 3");
  await expect(page.getByLabel("任务计划进度")).toContainText("2. 修改代码");
  await expect(page.getByLabel("任务计划进度")).toContainText("执行中");
});

test("keeps spacing between a historical plan and the next message", async ({ page }) => {
  const now = Date.now();
  await page.route("**/history/sessions", async (route) => route.fulfill({
    json: { sessions: [{ id: "plan-spacing", lastActivity: now, preview: "下一轮消息", context: { mode: "chat" } }] },
  }));
  await page.route("**/history/sessions/plan-spacing/messages", async (route) => route.fulfill({
    json: {
      messages: [
        {
          role: "assistant",
          text: "上一轮完成",
          toolCalls: [],
          timestamp: now - 2,
          turnId: "turn-1",
          plan: {
            id: "plan-1",
            turnId: "turn-1",
            status: "completed",
            createdAt: new Date(now - 3).toISOString(),
            updatedAt: new Date(now - 2).toISOString(),
            steps: [{ id: "step-1", title: "完成任务", status: "completed" }],
          },
        },
        { role: "user", text: "下一轮消息", toolCalls: [], timestamp: now - 1, turnId: "turn-2" },
      ],
    },
  }));
  await page.route("**/plan?*", async (route) => route.fulfill({ json: { plans: [] } }));
  await page.route("**/commands", async (route) => route.fulfill({ json: { commands: [] } }));

  await page.goto("/#sid=plan-spacing");

  const historicalPlan = page.locator(".chat-view .plan-progress");
  await expect(historicalPlan).toBeVisible();
  await expect(page.getByText("下一轮消息", { exact: true }).last()).toBeVisible();
  await expect.poll(() => historicalPlan.evaluate((element) => getComputedStyle(element).marginBottom)).toBe("28px");
});

test("restores and persists the execution mode for each session", async ({ page }) => {
  const modes = new Map([
    ["session-plan", "plan"],
    ["session-normal", "normal"],
  ]);
  const sessions = () => ([
    { id: "session-plan", lastActivity: 2, preview: "计划会话", context: { mode: "chat" }, executionMode: modes.get("session-plan") },
    { id: "session-normal", lastActivity: 1, preview: "普通会话", context: { mode: "chat" }, executionMode: modes.get("session-normal") },
  ]);
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: sessions() } }));
  await page.route("**/history/sessions/*/messages", async (route) => route.fulfill({ json: { messages: [] } }));
  await page.route("**/plan?*", async (route) => route.fulfill({ json: { plans: [] } }));
  await page.route("**/commands", async (route) => route.fulfill({ json: { commands: [] } }));
  await page.route("**/sessions/*/execution-mode", async (route) => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[2]);
    const body = route.request().postDataJSON() as { executionMode: "normal" | "plan" };
    modes.set(sessionId, body.executionMode);
    await route.fulfill({ json: { executionMode: body.executionMode } });
  });

  await page.goto("/#sid=session-plan");
  await expect(page.getByRole("button", { name: "计划", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "普通", exact: true }).click();
  await expect.poll(() => modes.get("session-plan")).toBe("normal");

  await page.reload();
  await expect(page.getByRole("button", { name: "普通", exact: true })).toHaveClass(/active/);
  await page.getByText("普通会话").click();
  await expect(page.getByRole("button", { name: "普通", exact: true })).toHaveClass(/active/);
});
