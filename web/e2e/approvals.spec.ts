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

test("shows expiry, renews without execution, and preserves the new deadline on reload", async ({ page }) => {
  let expiresAt = new Date(Date.now() - 1000).toISOString();
  let status = "expired";
  let renewals = 0;
  let executions = 0;
  const session = { id: "renew-chat", lastActivity: Date.now(), preview: "renew", context: { mode: "chat" }, attention: "approval" };
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [session] } }));
  await page.route("**/sessions", route => route.fulfill({ json: { sessions: [session] } }));
  await page.route("**/plan?*", route => route.fulfill({ json: { plans: [], run: { state: "waiting_approval", turnId: "renew-turn" } } }));
  await page.route("**/history/sessions/renew-chat/messages", route => route.fulfill({ json: {
    messages: [{ role: "assistant", text: "等待审批", timestamp: Date.now(), toolCalls: [{
      id: "renew-call", name: "bash", input: { command: "npm test" }, result: JSON.stringify({
        requiresConfirmation: true, approvalId: "renew-id", command: "npm test", approvalStatus: status, expiresAt,
      }),
    }] }],
  } }));
  await page.route("**/approvals/renew-id/renew", route => {
    renewals++;
    status = "pending";
    expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    return route.fulfill({ json: { approval: { ...approval, id: "renew-id", status, expiresAt } } });
  });
  await page.route("**/approvals/renew-id/approve-and-resume", route => {
    executions++;
    return route.fulfill({ status: 500 });
  });
  await page.goto("/#sid=renew-chat");
  await expect(page.locator(".tool-status")).toHaveText("审批已过期");
  await expect(page.getByRole("button", { name: "批准本次" })).toBeDisabled();
  await expect(page.locator(".tool-approval time")).toHaveAttribute("datetime", expiresAt);
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "重新申请审批" }).click();
  await expect(page.getByRole("button", { name: "批准本次" })).toBeEnabled();
  await expect(page.locator(".tool-status")).toHaveText("待审批");
  await expect(page.locator(".tool-approval time")).toHaveAttribute("datetime", expiresAt);
  expect(renewals).toBe(1);
  expect(executions).toBe(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "批准本次" })).toBeEnabled();
  await expect(page.locator(".tool-approval time")).toHaveAttribute("datetime", expiresAt);
  await page.screenshot({ path: "/tmp/approval-renew-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/approval-renew-mobile.png", fullPage: true });
});

for (const status of ["interrupted", "unknown"] as const) {
  test(`historical tool with no result is ${status}, not running`, async ({ page }) => {
    const session = { id: "expired-tool", lastActivity: Date.now(), preview: "expired tool", context: { mode: "chat" }, busy: false };
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [session] } }));
    await page.route("**/sessions", (route) => route.fulfill({ json: { sessions: [session] } }));
    await page.route("**/history/sessions/expired-tool/messages", (route) => route.fulfill({ json: {
      messages: [{ role: "assistant", text: "等待您的审批", timestamp: Date.now(), runState: "interrupted",
        toolCalls: [{ id: "call-expired", name: "bash", input: { command: "npm test" }, status,
          statusReason: "审批已过期或丢失，请核实操作结果后重新发起" }],
      }],
    } }));
    await page.goto("/#sid=expired-tool");
    await expect(page.locator(".tool-status")).toHaveText(status === "interrupted" ? "已中断" : "结果未知");
    await expect(page.locator(".tool-block.is-running")).toHaveCount(0);
    await expect(page.locator("textarea")).toBeEnabled();
    await page.locator(".tool-block summary").click();
    await expect(page.getByText("审批已过期或丢失，请核实操作结果后重新发起", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "批准本次" })).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".tool-status")).toHaveText(status === "interrupted" ? "已中断" : "结果未知");
  });
}

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
        sessions: [{ id: "approval-chat", lastActivity: Date.now(), preview: "approval", context: { mode: "chat" }, attention: "approval" }],
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
  await expect(page.locator(".session-attention-badge")).toHaveText("等待审批");
  await expect(page.locator("textarea")).toBeDisabled();
  const approvalBody = page.locator(".tool-body-approval");
  await expect(approvalBody).toBeVisible();
  expect((await approvalBody.boundingBox())?.height).toBeLessThan(360);
  await page.getByRole("button", { name: "批准本次" }).click();
  await expect(page.getByText("approved output", { exact: true })).toBeVisible();
  await expect(page.getByText("继续完成")).toBeVisible();
  await expect(page.locator(".tool-block")).toHaveCount(1);
});

test("rejects a persisted approval and resumes the original task", async ({ page }) => {
  let pending = true;
  const result = JSON.stringify({
    error: "bash 执行需要用户确认。",
    requiresConfirmation: true,
    approvalId: "approval-reject",
  });
  await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [{
    id: "approval-reject-chat", lastActivity: Date.now(), preview: "reject approval", context: { mode: "chat" }, attention: pending ? "approval" : undefined,
  }] } }));
  await page.route("**/history/sessions/approval-reject-chat/messages", (route) => route.fulfill({ json: { messages: [{
    role: "assistant", text: "", timestamp: Date.now(),
    toolCalls: [{ id: "reject-call", name: "bash", input: { command: "npm test" }, result }],
  }] } }));
  await page.route("**/approvals/approval-reject/reject-and-resume", (route) => {
    pending = false;
    return route.fulfill({
    headers: { "content-type": "text/event-stream" },
    body: [
      'event: tool_call\ndata: {"tool_call_id":"reject-call","name":"bash","input":{"command":"npm test"}}\n\n',
      'event: tool_result\ndata: {"tool_call_id":"reject-call","name":"bash","result":"{\\"error\\":\\"用户拒绝执行该工具调用\\",\\"rejected\\":true}"}\n\n',
      'event: done\ndata: {"text":"已取消该操作","session_id":"approval-reject-chat","reason":"completed"}\n\n',
    ].join(""),
    });
  });
  await page.goto("/#sid=approval-reject-chat");
  await page.getByRole("button", { name: "拒绝" }).click();
  await expect(page.getByText("已取消该操作", { exact: true })).toBeVisible();
  await expect(page.locator("textarea")).toBeEnabled();
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
    await route.fulfill({ json: { plans: [plan], activePlan: plan, currentTurnId: plan.turnId } });
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
