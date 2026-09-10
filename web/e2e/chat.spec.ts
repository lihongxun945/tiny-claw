import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/sessions/*/events", (route) => route.fulfill({ status: 503, body: "No mocked live stream" }));
});

for (const width of [390, 1280]) {
  test(`shows a restored activity line without a typing cursor during tools (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    let received = false;
    let finished = false;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const run = { id: "activity", turnId: "activity-turn", revision: 5, state: "running", startedAt: Date.now() - 10000,
      status: { stage: "execution:tool_running", state: "started", startedAt: Date.now() - 5000, message: `正在执行命令：npm run evaluate --output reports/${"long-name-".repeat(15)}.json` } };
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [{ id: "activity", preview: "activity", busy: !finished, lastActivity: Date.now(), context: { mode: "chat" } }] } }));
    await page.route("**/history/sessions/activity/messages", (route) => route.fulfill({ json: { messages: [] } }));
    await page.route("**/plan?*", async (route) => {
      if (received) await paused;
      await route.fulfill({ json: { plans: [], activePlan: null, run: finished ? { ...run, state: "completed", status: undefined, revision: 6 } : run } }).catch(() => {});
    });
    await page.route("**/sessions/activity/events", async (route) => {
      received = true;
      await route.fulfill({ contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({ run, turnId: run.turnId, text: "开始验证", status: run.status.message, toolCalls: [], sequence: 5 })}\n\nevent: done\ndata: ${JSON.stringify({ text: "开始验证", session_id: "activity", reason: "completed", sequence: 6 })}\n\n` });
    });
    try {
      await page.goto("/#sid=activity");
      const line = page.locator(".execution-status");
      await expect(line).toContainText("正在执行命令：npm run evaluate");
      await expect(line).toContainText("已耗时");
      await expect(page.locator(".streaming-cursor")).toHaveCount(0);
      await expect(page.locator("textarea")).toBeDisabled();
      expect(await line.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/activity-status-${width}.png` });
      finished = true;
      release();
      await expect(line).toHaveCount(0);
      await expect(page.locator("textarea")).toBeEnabled();
    } finally {
      release();
    }
  });
}

for (const mode of ["chat", "project"]) {
  test(`shows synchronous compression after an answer and restores it on reload (${mode})`, async ({ page }) => {
    let busy = true;
    let finishing = false;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const status = "正在进行上下文压缩...";
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [{
      id: "compressing", lastActivity: Date.now(), preview: "压缩测试", context: { mode, ...(mode === "project" ? { project: { root: "/tmp/compression-project", name: "compression-project" } } : {}) }, busy,
    }] } }));
    await page.route("**/history/sessions/compressing/messages", (route) => route.fulfill({ json: { messages: [
      { role: "assistant", text: "您要继续吗？", turnId: "compress-turn", timestamp: 1, toolCalls: [] },
    ] } }));
    await page.route("**/plan?*", async (route) => {
      if (finishing) await paused;
      await route.fulfill({ json: { plans: [], activePlan: null } }).catch(() => {});
    });
    await page.route("**/sessions/compressing/events", async (route) => {
      finishing = true;
      await route.fulfill({ contentType: "text/event-stream", body: [
        `event: snapshot\ndata: ${JSON.stringify({ turnId: "compress-turn", text: "您要继续吗？", status, toolCalls: [], sequence: 4 })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ text: "您要继续吗？", session_id: "compressing", reason: "completed", sequence: 5 })}\n\n`,
      ].join("") });
    });
    await page.goto("/#sid=compressing");
    try {
      await expect(page.getByRole("status").filter({ hasText: status })).toBeVisible();
      await expect(page.locator("textarea")).toBeDisabled();
      await expect(page.locator(".streaming-cursor")).toHaveCount(0);
      await expect(page.locator(".message.assistant")).toHaveCount(1);
      await page.reload();
      await expect(page.getByRole("status").filter({ hasText: status })).toBeVisible();
      await expect(page.locator("textarea")).toBeDisabled();
      await expect(page.locator(".streaming-cursor")).toHaveCount(0);
      busy = false;
      release();
      await expect(page.locator("textarea")).toBeEnabled();
      await expect(page.getByText(status, { exact: true })).toHaveCount(0);
    } finally { release(); }
  });
}

test("explicitly resumes the selected plan and preserves its earlier snapshot", async ({ page }) => {
  const plan = { id: "chosen-plan", turnId: "old-turn", goal: "验证功能", status: "planning",
    createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", steps: [{ id: "step-1", title: "验证", status: "pending" }] };
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [{ id: "resume", lastActivity: 1, preview: "旧任务", context: { mode: "chat" } }] } }));
  await page.route("**/history/sessions/resume/messages", (route) => route.fulfill({ json: { messages: [{ role: "assistant", text: "先暂停", turnId: "old-turn", timestamp: 1, toolCalls: [], plan }] } }));
  await page.route("**/plan?*", (route) => route.fulfill({ json: { plans: [plan], activePlan: null } }));
  let request: Record<string, unknown> | undefined;
  await page.route("**/chat", async (route) => {
    request = route.request().postDataJSON();
    await route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"text":"已恢复","session_id":"resume","reason":"completed"}\n\n' });
  });
  await page.goto("/#sid=resume");
  await page.locator(".plan-history summary").click();
  await page.getByRole("button", { name: "继续此计划" }).click();
  await expect.poll(() => request?.plan_id).toBe("chosen-plan");
  expect(request?.execution_mode).toBe("normal");
  expect(request?.turn_id).not.toBe("old-turn");
  await expect(page.getByText("先暂停", { exact: true })).toBeVisible();
});

test("reconnects a busy turn and replaces its partial history with one streaming answer", async ({ page }) => {
  let busy = true;
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  let finishing = false;
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "reconnect", lastActivity: Date.now(), preview: "恢复输出", context: { mode: "chat" }, busy },
  ] } }));
  await page.route("**/history/sessions/reconnect/messages", (route) => route.fulfill({ json: { messages: [
    { role: "user", text: "执行任务", toolCalls: [], turnId: "turn-live", timestamp: 1 },
    { role: "assistant", text: busy ? "刷新前输出" : "刷新前输出，刷新后继续输出", toolCalls: [], turnId: "turn-live", timestamp: 2 },
  ] } }));
  await page.route("**/plan?*", async (route) => {
    if (finishing) await pause;
    await route.fulfill({ json: { plans: [], activePlan: null } });
  });
  await page.route("**/sessions/reconnect/events", async (route) => {
    finishing = true;
    await route.fulfill({ contentType: "text/event-stream", body: [
      'event: snapshot\ndata: {"turnId":"turn-live","text":"刷新前输出","status":"执行中","toolCalls":[]}\n\n',
      'event: text_delta\ndata: {"text":"，刷新后继续输出"}\n\n',
      'event: done\ndata: {"text":"刷新前输出，刷新后继续输出","session_id":"reconnect","reason":"completed"}\n\n',
    ].join("") });
  });
  await page.goto("/#sid=reconnect");
  await expect(page.locator(".chat-view .message.assistant")).toHaveCount(1);
  await expect(page.locator(".chat-view .message.assistant")).toContainText("刷新前输出，刷新后继续输出");
  await expect(page.locator(".streaming-cursor")).toBeVisible();
  await expect(page.locator("textarea")).toBeDisabled();
  await expect(page.getByText("正在后台执行", { exact: true })).toHaveCount(0);
  busy = false;
  release();
  await expect(page.locator("textarea")).toBeEnabled();
  await expect(page.locator(".chat-view .message.assistant")).toHaveCount(1);
  await expect(page.locator(".streaming-cursor")).toHaveCount(0);
});

test("keeps partial output stable across reconnect failures", async ({ page }) => {
  let requests = 0;
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [{
    id: "stable-reconnect", lastActivity: Date.now(), context: { mode: "chat" }, busy: true,
  }] } }));
  await page.route("**/history/sessions/stable-reconnect/messages", route => route.fulfill({ json: { messages: [{
    role: "assistant", text: "已有输出", turnId: "stable-turn", toolCalls: [], timestamp: 1,
  }] } }));
  await page.route("**/plan?*", route => route.fulfill({ json: {
    plans: [], activePlan: null, run: { state: "running", turnId: "stable-turn" },
  } }));
  await page.route("**/sessions/stable-reconnect/events", route => {
    requests++;
    if (requests > 1) return route.abort();
    return route.fulfill({ contentType: "text/event-stream", body:
      'event: snapshot\ndata: {"turnId":"stable-turn","text":"已有输出，继续内容","toolCalls":[]}\n\n',
    });
  });
  await page.goto("/#sid=stable-reconnect");
  await expect(page.getByText("已有输出，继续内容", { exact: true })).toBeVisible();
  await expect.poll(() => requests, { timeout: 15000 }).toBeGreaterThan(1);
  await expect(page.getByText("已有输出，继续内容", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-view .message.assistant")).toHaveCount(1);
  await expect(page.getByText("正在后台执行", { exact: true })).toHaveCount(0);
  await expect(page.locator("textarea")).toBeDisabled();
});

test("distinguishes blocked calls from execution failures in history", async ({ page }) => {
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "blocked", lastActivity: Date.now(), preview: "工具拦截", context: { mode: "chat" } },
  ] } }));
  await page.route("**/history/sessions/blocked/messages", (route) => route.fulfill({ json: { messages: [
    { role: "assistant", text: "", timestamp: 1, toolCalls: [
      { name: "bash", input: {}, result: JSON.stringify({ status: "blocked", error: "本轮尚未绑定计划" }) },
      { name: "file_read", input: {}, result: JSON.stringify({ error: "文件不存在" }) },
      { name: "git_status", input: {}, result: "ok" },
    ] },
  ] } }));
  await page.goto("/#sid=blocked");
  const header = page.locator(".tool-call-group-header");
  await expect(header).toContainText("1 成功 · 1 失败 · 1 已拦截");
  await header.click();
  const blocked = page.locator(".tool-block").filter({ has: page.locator(".tool-name", { hasText: "bash" }) });
  await expect(blocked.locator(".tool-status")).toHaveText("已拦截");
  await expect(blocked).not.toHaveClass(/is-failed/);
});

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

test("shows and refreshes busy session state in the sidebar", async ({ page }) => {
  let busy = true;
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [{
          id: "busy-session",
          lastActivity: Date.now(),
          preview: "long task",
          context: { mode: "chat" },
          executionMode: "normal",
          busy,
        }],
      },
    });
  });
  await page.route("**/history/sessions/busy-session/messages", async (route) => {
    await route.fulfill({ json: { messages: [] } });
  });

  await page.goto("/");

  await expect(page.locator(".session-item.is-busy")).toBeVisible();
  await expect(page.locator(".session-busy-badge")).toHaveText("执行中");
  busy = false;
  await expect(page.locator(".session-item.is-busy")).toHaveCount(0, { timeout: 5000 });
});

test("locks the active composer and refreshes messages while the active session is busy", async ({ page }) => {
  let busy = true;
  let messages = [{ role: "user", text: "开始长任务", toolCalls: [], timestamp: Date.now() }];
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({
      json: {
        sessions: [{
          id: "busy-session",
          lastActivity: Date.now(),
          preview: "long task",
          context: { mode: "chat" },
          executionMode: "normal",
          busy,
        }],
      },
    });
  });
  await page.route("**/history/sessions/busy-session/messages", async (route) => {
    await route.fulfill({ json: { messages } });
  });
  await page.route("**/sessions/busy-session/cancel", async (route) => {
    await expect(page.getByRole("button", { name: "正在停止...", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox")).toBeDisabled();
    busy = false;
    messages = [
      ...messages,
      { role: "assistant", text: "任务已停止", toolCalls: [], timestamp: Date.now() },
    ];
    await route.fulfill({ json: { cancelled: true } });
  });

  await page.goto("/#sid=busy-session");

  await expect(page.locator(".execution-status")).toContainText("连接已断开，正在重连");
  await expect(page.locator(".processing-indicator .streaming-cursor")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(page.getByText("任务已停止")).toBeVisible();
});

test("syntax highlights fenced code in assistant messages", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: {
      sessions: [{ id: "code-session", lastActivity: Date.now(), preview: "code", context: { mode: "chat" } }],
    } });
  });
  await page.route("**/history/sessions/code-session/messages", async (route) => {
    await route.fulfill({ json: { messages: [{
      role: "assistant",
      text: "```typescript\nconst greeting: string = \"hello\";\n```",
      toolCalls: [],
      timestamp: Date.now(),
    }] } });
  });

  await page.goto("/");
  await page.getByText("code-ses").click();

  const code = page.locator(".message.assistant pre code.hljs.language-typescript");
  await expect(code).toBeVisible();
  await expect(code.locator(".hljs-keyword")).toHaveText("const");
  await expect(code.locator(".hljs-string")).toHaveText('"hello"');
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

test("shows progress in unified mode and preserves it in history", async ({ page }) => {
  let requestedMode = "";
  let sessionId = "";
  const plan = {
    id: "plan-1",
    goal: "让任务执行过程清晰可见",
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
        `event: tool_call\ndata: ${JSON.stringify({ tool_call_id: "tool-1", name: "update_plan", input: { steps: plan.steps.map((step) => step.title) } })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({ tool_call_id: "tool-1", name: "update_plan", result: JSON.stringify({ plan }) })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ text: "正在按计划执行", session_id: body.session_id, reason: "completed" })}\n\n`,
      ].join(""),
    });
  });

  await page.goto("/");
  await expect(page.getByRole("group", { name: "执行模式" })).toHaveCount(0);
  await page.locator("textarea").fill("实现计划模式");
  await page.locator("textarea").press("Enter");

  await expect.poll(() => requestedMode).toBe("normal");
  await expect.poll(() => sessionId.length > 0).toBe(true);
  await expect(page.getByLabel("任务计划进度")).toBeVisible();
  await expect(page.getByLabel("任务计划进度")).toContainText("1 / 3");
  const record = page.locator(".plan-history");
  await expect(record.locator("summary")).toContainText("本轮已结束（未完成）");
  await expect(record.locator("summary")).toContainText(plan.goal);
  await expect(record.locator(".plan-step-list")).not.toBeVisible();
  await expect(record.locator(".plan-progress-track")).toHaveCount(0);
  await expect(record).toHaveCSS("box-shadow", "none");
  await expect(record).toHaveCSS("border-top-width", "0px");
  await record.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(record.locator(".plan-step-list")).toBeVisible();
  await expect(page.getByLabel("任务计划进度")).toContainText("2. 修改代码");
  await expect(page.getByLabel("任务计划进度")).toContainText("进行中");
  await expect(page.locator(".plan-progress").filter({ has: page.locator(".plan-step") })).toHaveCount(1);
  await expect(page.locator(".chat-view .plan-progress")).toBeVisible();
  await record.locator("summary").click();
  await expect(record.locator(".plan-step-list")).not.toBeVisible();
});

for (const mode of ["normal", "plan"]) {
  test(`does not restore a paused task above the composer after an unrelated ${mode} turn`, async ({ page }) => {
    const plan = {
      id: "old-plan", turnId: "old-turn", status: "executing", currentStepId: "step-1",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      steps: [{ id: "step-1", title: "旧任务待确认", status: "waiting_user" }, { id: "step-2", title: "旧任务后续", status: "pending" }],
    };
    const messages = [{ role: "assistant", text: "等待确认", toolCalls: [], timestamp: Date.now(), turnId: "old-turn", plan }];
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
      { id: "paused-session", lastActivity: Date.now(), preview: "旧任务", context: { mode: "chat" }, executionMode: mode },
    ] } }));
    await page.route("**/history/sessions/paused-session/messages", (route) => route.fulfill({ json: { messages } }));
    await page.route("**/commands", (route) => route.fulfill({ json: { commands: [] } }));
    await page.route("**/plan?*", (route) => route.fulfill({ json: { plans: [plan], activePlan: null } }));
    await page.route("**/chat", (route) => {
      expect(route.request().postDataJSON().execution_mode).toBe("normal");
      return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"text":"这是新问题的回答","session_id":"paused-session","reason":"completed"}\n\n' });
    });
    await page.goto("/#sid=paused-session");
    await expect(page.locator(".chat-view .plan-progress")).toBeVisible();
    await expect(page.locator(".plan-progress")).toHaveCount(1);
    await page.locator("textarea").fill("解释另一个问题");
    await page.locator("textarea").press("Enter");
    await expect(page.getByText("这是新问题的回答", { exact: true })).toBeVisible();
    await expect(page.locator(".plan-progress")).toHaveCount(1);
    await expect(page.locator(".chat-view .plan-progress")).toBeVisible();
    await page.reload();
    await expect(page.locator(".chat-view .plan-progress")).toBeVisible();
    await expect(page.locator(".plan-progress")).toHaveCount(1);
  });
}

for (const mode of ["chat", "project"]) {
test(`preserves per-turn plan snapshots on reload and moves the active plan into history in ${mode} mode`, async ({ page }) => {
  let busy = true;
  const plan = {
    id: "running-plan", turnId: "create-turn", relatedTurnIds: ["resume-turn"], status: "executing",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    steps: [{ id: "step-1", title: "当前执行步骤", status: "in_progress" }, { id: "step-2", title: "验证", status: "pending" }],
  };
  const oldPlan = { ...plan, steps: plan.steps.map((step, index) => ({ ...step, status: index === 0 ? "waiting_approval" : "pending" })) };
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "running-session", lastActivity: Date.now(), preview: "执行任务", context: { mode, ...(mode === "project" ? { project: { root: "/tmp/plan-project", name: "plan-project" } } : {}) }, busy },
  ] } }));
  await page.route("**/history/sessions/running-session/messages", (route) => route.fulfill({ json: { messages: [
    { role: "assistant", text: "原轮次回答", turnId: "create-turn", timestamp: Date.now() - 2, toolCalls: [], plan: oldPlan },
    { role: "user", text: "继续任务", turnId: "resume-turn", timestamp: Date.now() - 1, toolCalls: [] },
    ...(!busy ? [{ role: "assistant", text: "请确认后续操作", turnId: "resume-turn", timestamp: Date.now(), toolCalls: [], plan }] : []),
  ] } }));
  await page.route("**/commands", (route) => route.fulfill({ json: { commands: [] } }));
  await page.route("**/plan?*", (route) => route.fulfill({ json: {
    plans: [plan], activePlan: busy ? plan : null, currentTurnId: busy ? "resume-turn" : undefined,
  } }));
  await page.goto("/#sid=running-session");
  await expect(page.locator(".plan-progress")).toHaveCount(2);
  await expect(page.locator(".chat-view .plan-progress")).toHaveCount(1);
  const activePlan = page.locator(".chat-area > .plan-progress");
  const planToggle = activePlan.getByRole("button", { name: /任务计划/ });
  await expect(planToggle).toHaveAttribute("aria-expanded", "false");
  await expect(planToggle).toContainText("执行中 · 0 / 2");
  await expect(planToggle).toContainText("第 1 步：当前执行步骤");
  await expect(activePlan.locator(".plan-progress-track")).toHaveCount(0);
  if (mode === "chat") {
    await page.screenshot({ path: "/tmp/tiny-claw-progress-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(planToggle).toBeInViewport();
    await page.screenshot({ path: "/tmp/tiny-claw-progress-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await expect(activePlan.locator(".plan-step-list")).toHaveCount(0);
  await planToggle.click();
  await expect(planToggle).toHaveAttribute("aria-expanded", "true");
  await expect(activePlan.locator(".plan-step-list")).toBeVisible();
  await expect(page.locator("textarea")).toBeDisabled();
  await page.reload();
  await expect(page.getByText("原轮次回答", { exact: true })).toBeVisible();
  await expect(page.locator(".plan-progress")).toHaveCount(2);
  await expect(page.locator(".chat-view .plan-progress")).toHaveCount(1);
  await expect(page.locator(".chat-area > .plan-progress").getByRole("button", { name: /任务计划/ })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".chat-area > .plan-progress")).toContainText("当前执行步骤");
  await expect(page.locator("textarea")).toBeDisabled();
  plan.steps[0].status = "waiting_user";
  busy = false;
  await expect(page.locator("textarea")).toBeEnabled();
  await expect(page.locator(".chat-area > .plan-progress")).toHaveCount(0);
  await expect(page.locator(".chat-view .plan-progress").last()).toContainText("等待用户");
  await expect(page.locator(".plan-progress")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".plan-progress")).toHaveCount(2);
  await expect(page.locator(".chat-view .plan-progress").last()).toContainText("等待用户");
});
}

test("ignores an old plan response that arrives after a new message", async ({ page }) => {
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
  let requestStarted = false;
  const plan = {
    id: "stale-plan", turnId: "old-turn", status: "executing",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    steps: [{ id: "step-1", title: "过期任务", status: "in_progress" }],
  };
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [
    { id: "race-session", lastActivity: Date.now(), preview: "竞态测试", context: { mode: "chat" } },
  ] } }));
  await page.route("**/history/sessions/race-session/messages", (route) => route.fulfill({ json: { messages: [] } }));
  await page.route("**/commands", (route) => route.fulfill({ json: { commands: [] } }));
  await page.route("**/plan?*", async (route) => {
    if (!requestStarted) {
      requestStarted = true;
      await oldResponse;
      await route.fulfill({ json: { plans: [plan], activePlan: plan, currentTurnId: "old-turn" } });
    } else await route.fulfill({ json: { plans: [plan], activePlan: null } });
  });
  await page.route("**/chat", (route) => route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"text":"新回答","session_id":"race-session","reason":"completed"}\n\n' }));
  await page.goto("/#sid=race-session");
  await expect.poll(() => requestStarted).toBe(true);
  await page.locator("textarea").fill("新问题");
  await page.locator("textarea").press("Enter");
  await expect(page.getByText("新回答", { exact: true })).toBeVisible();
  const response = page.waitForResponse((res) => res.url().includes("/plan?"));
  releaseOld();
  await response;
  await expect(page.locator(".plan-progress")).toHaveCount(0);
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

test("does not restore the mode switch from legacy session preferences", async ({ page }) => {
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
  await expect(page.getByRole("group", { name: "执行模式" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("group", { name: "执行模式" })).toHaveCount(0);
  await page.getByText("普通会话").click();
  await expect(page.getByRole("group", { name: "执行模式" })).toHaveCount(0);
});
