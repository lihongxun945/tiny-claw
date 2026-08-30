import { expect, test } from "@playwright/test";

test("uses the system theme, switches themes, and persists the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("theme-test-initialized")) {
      localStorage.removeItem("tiny-claw-theme");
      sessionStorage.setItem("theme-test-initialized", "true");
    }
  });
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "切换到浅色模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tiny-claw-theme"))).toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "切换到深色模式" })).toBeVisible();
});
