import { expect, test } from "@playwright/test";

test("edits compression watermarks as percentages and surfaces server validation", async ({ page }) => {
  let saved: Record<string, unknown> = {};
  await page.route("**/history/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/config", route => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      if (Number(saved.contextCompressionTargetRatio) >= Number(saved.contextCompressionThreshold)) {
        return route.fulfill({ status: 400, json: { error: "目标阈值必须小于触发阈值" } });
      }
      return route.fulfill({ json: { config: saved } });
    }
    return route.fulfill({ json: { config: {}, defaults: {
      contextCompressionThreshold: 0.8, contextCompressionTargetRatio: 0.2,
      sessionSummary: { recentBatchCount: 5, maxBatchTokens: 1500, maxBudgetRatio: 0.1 },
    } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "配置" }).click();
  const trigger = page.getByLabel("上下文压缩触发阈值（%）", { exact: true });
  const target = page.getByLabel("压缩目标（%，必须小于触发阈值）", { exact: true });
  await expect(trigger).toHaveValue("80");
  await expect(target).toHaveValue("20");
  await trigger.fill("75");
  await target.fill("75");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/目标阈值必须小于触发阈值/)).toBeVisible();
  await target.fill("15");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/配置已保存/)).toBeVisible();
  expect(saved.contextCompressionThreshold).toBe(0.75);
  expect(saved.contextCompressionTargetRatio).toBe(0.15);
});
