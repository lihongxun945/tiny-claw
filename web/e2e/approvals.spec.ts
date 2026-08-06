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
        sessions: [{ id: "approval-chat", lastActivity: Date.now(), preview: "approval", context: { mode: "chat" } }],
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
            id: "call-1",
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
        "data: {\"tool_call_id\":\"call-1\",\"name\":\"bash\",\"input\":{\"command\":\"npm test\"}}",
        "",
        "event: tool_result",
        "data: {\"tool_call_id\":\"call-1\",\"name\":\"bash\",\"result\":\"{\\\"stdout\\\":\\\"approved output\\\",\\\"stderr\\\":\\\"\\\",\\\"exitCode\\\":0}\"}",
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
  const approvalBody = page.locator(".tool-body-approval");
  await expect(approvalBody).toBeVisible();
  expect((await approvalBody.boundingBox())?.height).toBeLessThan(360);
  await page.getByRole("button", { name: "批准本次" }).click();
  await expect(page.getByText("approved output", { exact: true })).toBeVisible();
  await expect(page.getByText("继续完成")).toBeVisible();
  await expect(page.locator(".tool-block")).toHaveCount(1);
});

test("refreshes a waiting plan as soon as approved tool execution resumes", async ({ page }) => {
  const result = JSON.stringify({
    error: "bash 执行需要用户确认。",
    requiresConfirmation: true,
    approvalId: "approval-plan-1",
    command: "npm test",
    cwd: "/tmp/workspace",
  });
  const waitingPlan = {
    id: "plan-approval",
    turnId: "turn-approval",
    status: "executing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStepId: "step-1",
    steps: [{ id: "step-1", title: "运行测试", status: "waiting_approval" }],
  };
  let planReads = 0;

  await page.route("**/history/sessions", async (route) => route.fulfill({
    json: { sessions: [{ id: "approval-plan", lastActivity: Date.now(), preview: "approval plan", context: { mode: "chat" }, executionMode: "plan" }] },
  }));
  await page.route("**/history/sessions/approval-plan/messages", async (route) => route.fulfill({
    json: { messages: [{
      role: "assistant",
      text: "",
      toolCalls: [{ id: "call-plan-1", name: "bash", input: { command: "npm test" }, result }],
      timestamp: Date.now(),
      turnId: "turn-approval",
    }] },
  }));
  await page.route("**/plan?*", async (route) => {
    planReads += 1;
    const plan = planReads === 1
      ? waitingPlan
      : { ...waitingPlan, steps: [{ ...waitingPlan.steps[0], status: "in_progress" }] };
    await route.fulfill({ json: { plans: [plan] } });
  });
  await page.route("**/approvals/approval-plan-1/approve-and-resume", async (route) => route.fulfill({
    headers: { "content-type": "text/event-stream" },
    body: [
      "event: tool_call",
      "data: {\"tool_call_id\":\"call-plan-1\",\"name\":\"bash\",\"input\":{\"command\":\"npm test\"}}",
      "",
      "event: tool_result",
      "data: {\"tool_call_id\":\"call-plan-1\",\"name\":\"bash\",\"result\":\"running\"}",
      "",
      "event: done",
      "data: {\"text\":\"仍在执行后续步骤\",\"session_id\":\"approval-plan\"}",
      "",
      "",
    ].join("\n"),
  }));

  await page.goto("/");
  await page.locator(".session-item", { hasText: "approval plan" }).click();
  await expect(page.getByLabel("任务计划进度")).toContainText("等待审批");
  await page.getByRole("button", { name: "批准本次" }).click();
  await expect(page.getByLabel("任务计划进度")).toContainText("执行中");
  expect(planReads).toBeGreaterThan(1);
});

test("allows every approval in the current turn from the chat tool block", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 });
  const longCommand = Array.from({ length: 12 }, (_, index) => `echo approval-${index}`).join(" && ");
  const result = JSON.stringify({
    error: "bash 执行需要用户确认。",
    requiresConfirmation: true,
    approvalId: "approval-turn-1",
    command: longCommand,
    cwd: "/tmp/workspace",
  });

  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [{ id: "approval-turn", lastActivity: Date.now(), preview: "approval turn", context: { mode: "chat" } }] } });
  });
  await page.route("**/history/sessions/approval-turn/messages", async (route) => {
    await route.fulfill({
      json: {
        messages: [{
          role: "assistant",
          text: "",
          toolCalls: [{ id: "call-1", name: "bash", input: { command: longCommand }, result }],
          timestamp: Date.now(),
        }],
      },
    });
  });
  await page.route("**/approvals/approval-turn-1/approve-turn-and-resume", async (route) => {
    await route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: [
        "event: tool_call",
        "data: {\"tool_call_id\":\"call-1\",\"name\":\"bash\",\"input\":{\"command\":\"npm test\"}}",
        "",
        "event: tool_result",
        "data: {\"tool_call_id\":\"call-1\",\"name\":\"bash\",\"result\":\"{\\\"stdout\\\":\\\"turn output\\\",\\\"exitCode\\\":0}\"}",
        "",
        "event: done",
        "data: {\"text\":\"本轮完成\",\"session_id\":\"approval-turn\"}",
        "",
        "",
      ].join("\n"),
    });
  });

  await page.goto("/");
  await page.locator(".session-id", { hasText: "approval" }).click();

  await expect(page.getByText(/仅对当前用户消息/)).toBeVisible();
  const approveOnce = page.getByRole("button", { name: "批准本次" });
  const approveTurn = page.getByRole("button", { name: "允许本轮" });
  const reject = page.getByRole("button", { name: "拒绝" });
  const approvalContent = page.locator(".tool-approval-content");
  const contentOverflow = await approvalContent.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(contentOverflow).toBe(true);
  await expect(approveOnce).toBeInViewport();
  await expect(approveTurn).toBeInViewport();
  await expect(reject).toBeInViewport();
  await approveTurn.click();
  await expect(page.getByText("turn output", { exact: true })).toBeVisible();
  await expect(page.getByText("本轮完成")).toBeVisible();
});
