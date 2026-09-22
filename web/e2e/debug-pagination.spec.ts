import { expect, test } from "@playwright/test";

test("paginates model calls and resets pages for filtering and page size", async ({ page }) => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  let startedSlow!: () => void;
  const started = new Promise<void>(resolve => { startedSlow = resolve; });
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/logs", route => route.fulfill({ json: { files: [] } }));
  await page.route("**/debug/model-calls?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    const id = query.get("id");
    if (id) {
      expect(query.get("view")).toBe("display");
      await route.fulfill({ json: { trace: { requestId: id, events: [{ phase: "request", timestamp: "2026-09-21", data: { selected: id } }] } } });
      return;
    }
    const current = Number(query.get("page"));
    const size = Number(query.get("page_size"));
    if (query.get("session_id") === "slow") { startedSlow(); await slow; }
    const total = query.has("session_id") ? 1 : 45;
    await route.fulfill({ json: { page: current, pageSize: size, total,
      traces: Array.from({ length: Math.min(size, total - (current - 1) * size) }, (_, index) => ({
        requestId: `call-${(current - 1) * size + index}`, model: `model-${(current - 1) * size + index}`,
        provider: "test", mode: "chat", status: "success", startedAt: "2026-09-21", eventCount: 1,
      })) } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "日志", exact: true }).click();
  await page.getByRole("button", { name: "模型调用", exact: true }).click();
  await expect(page.locator(".model-call-item")).toHaveCount(20);
  await expect(page.getByText("第 1 / 3 页 · 共 45 条")).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("第 2 / 3 页 · 共 45 条")).toBeVisible();
  await expect(page.locator(".model-event-json")).toContainText("call-20");
  await page.getByLabel("每页调用条数").selectOption("50");
  await expect(page.locator(".model-call-item")).toHaveCount(45);
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
  await page.getByLabel("Session 筛选").fill("filtered");
  await page.getByLabel("Session 筛选").press("Enter");
  await expect(page.locator(".model-call-item")).toHaveCount(1);
  await expect(page.getByText("第 1 / 1 页 · 共 1 条")).toBeVisible();
  await page.getByLabel("Session 筛选").fill("slow");
  await page.getByLabel("Session 筛选").press("Enter");
  await started;
  await page.getByLabel("Session 筛选").fill("");
  await page.getByLabel("Session 筛选").press("Enter");
  await expect(page.locator(".model-call-item")).toHaveCount(45);
  releaseSlow();
  await expect(page.getByText("第 1 / 1 页 · 共 45 条")).toBeVisible();
});
