import { expect, test } from "@playwright/test";

const approval = {
  id: "approval-1",
  source: "bash",
  command: "npm test",
  cwd: "/tmp/workspace",
  status: "pending",
  createdAt: "2026-06-02T00:00:00.000Z",
  expiresAt: "2026-06-02T00:10:00.000Z",
};

test("approves a pending command once", async ({ page }) => {
  let current = { ...approval };
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/approvals", async (route) => {
    await route.fulfill({ json: { approvals: [current] } });
  });
  await page.route("**/approvals/approval-1/approve", async (route) => {
    current = { ...current, status: "approved" };
    await route.fulfill({ json: { approval: current } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "审批" }).click();

  await expect(page.getByText("npm test")).toBeVisible();
  await page.getByRole("button", { name: "允许一次" }).click();
  await expect(page.getByText("已允许一次。请重新发起原任务。")).toBeVisible();
  await expect(page.getByText("已允许一次", { exact: true })).toBeVisible();
});
