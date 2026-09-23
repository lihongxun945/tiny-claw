import { expect, test } from "@playwright/test";

test("uses the system theme, switches themes, and persists the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("theme-test-initialized")) {
      localStorage.removeItem("breeze-coder-theme");
      sessionStorage.setItem("theme-test-initialized", "true");
    }
  });
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));

  await page.goto("/");
  await expect(page).toHaveTitle("Breeze Coder");
  await expect(page.locator(".brand")).toHaveText("Breeze Coder");
  await expect.poll(() => page.locator(".brand-mark").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "切换到浅色模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("breeze-coder-theme"))).toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "切换到深色模式" })).toBeVisible();
});
