import { expect, test } from "@playwright/test";

const memory = {
  name: "project-context",
  summary: "项目背景",
  content: "tiny-claw project",
  tags: ["project"],
  scope: "project",
  sensitive: false,
  disabled: false,
  source: "manual",
  createdAt: "2026-06-02T00:00:00.000Z",
  updatedAt: "2026-06-02T00:00:00.000Z",
};

test("manages long-term memories", async ({ page }) => {
  let current = { ...memory };
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/memory?*", async (route) => {
    await route.fulfill({ json: { memories: [current] } });
  });
  await page.route("**/memory/project-context", async (route) => {
    if (route.request().method() === "PUT") {
      current = { ...current, ...route.request().postDataJSON(), updatedAt: "2026-06-02T01:00:00.000Z" };
      await route.fulfill({ json: { memory: current } });
      return;
    }
    await route.fulfill({ json: { memory: current } });
  });
  await page.route("**/memory/project-context/disable", async (route) => {
    current = { ...current, disabled: true };
    await route.fulfill({ json: { memory: current } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "记忆" }).click();

  await expect(page.getByRole("heading", { name: "project-context" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "摘要" })).toHaveValue("项目背景");
  await page.getByRole("textbox", { name: "摘要" }).fill("更新后的摘要");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("记忆已保存")).toBeVisible();

  await page.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(page.getByText("记忆已禁用")).toBeVisible();
  await expect(page.getByRole("button", { name: "启用", exact: true })).toBeVisible();
});

test("shows API errors instead of a misleading empty state", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/memory?*", async (route) => {
    await route.fulfill({ status: 500, json: { error: "memory api failed" } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "记忆" }).click();

  await expect(page.getByText("memory api failed")).toBeVisible();
  await expect(page.getByText("暂无记忆")).not.toBeVisible();
});
