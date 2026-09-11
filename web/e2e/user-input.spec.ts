import { test, expect } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`restores a question, dismisses without cancelling and submits once (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    let answered = false;
    let submissions = 0;
    const request = { id: "question-1", kind: "user_input", status: "pending", payload: { question: "这次评测采用哪种规模？", context: "较大样本更可靠，但执行时间更长。", type: "single_choice", options: [{ id: "small", label: "40 局快速验证" }, { id: "large", label: "160 局正式评测" }], maxAnswerChars: 12000 } };
    const run = () => ({ id: "r1", turnId: "t1", state: answered ? "completed" : "waiting_user", revision: answered ? 3 : 2, suspension: { ...request, status: answered ? "answered" : "pending" } });
    await page.route("**/history/sessions", (route) => route.fulfill({ json: { sessions: [{ id: "question", preview: "question", context: { mode: "chat" }, lastActivity: 1, busy: false, attention: answered ? undefined : "input" }] } }));
    await page.route("**/history/sessions/question/messages", (route) => route.fulfill({ json: { messages: [{ role: "assistant", text: answered ? "已收到答案，执行完成" : "请确认评测规模", toolCalls: [], turnId: "t1", timestamp: 1 }] } }));
    await page.route("**/plan?*", (route) => route.fulfill({ json: { plans: [], activePlan: null, run: run() } }));
    await page.route("**/user-input/answer", async (route) => {
      submissions++;
      expect(route.request().postDataJSON()).toMatchObject({ session_id: "question", request_id: "question-1", selectedIds: ["small"], text: "先验证正确性" });
      answered = true;
      await route.fulfill({ contentType: "text/event-stream", body: `event: run_state\ndata: ${JSON.stringify({ run: run(), sequence: 1 })}\n\nevent: done\ndata: ${JSON.stringify({ text: "已收到答案，执行完成", reason: "completed", session_id: "question", sequence: 2 })}\n\n` });
    });
    await page.goto("/#sid=question");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator(".streaming-cursor")).toHaveCount(0);
    await expect(page.locator(".chat-input textarea")).toBeDisabled();
    await expect(dialog.getByRole("radio").first()).not.toBeChecked();
    await page.screenshot({ path: `/tmp/user-question-${width}.png` });
    expect(await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth && element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole("button", { name: "稍后回答", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "回答问题", exact: true })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "回答问题", exact: true }).click();
    await dialog.getByLabel("40 局快速验证").check();
    await dialog.getByLabel("补充或自定义回答").fill("先验证正确性");
    await dialog.getByRole("button", { name: "提交并继续" }).click();
    await expect(page.getByText("已收到答案，执行完成")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".chat-input textarea")).toBeEnabled();
    expect(submissions).toBe(1);
  });
}
