import { expect, test } from "@playwright/test";

test("edits the global dangerous operation mode", async ({ page }) => {
  let savedConfig: Record<string, unknown> | undefined;
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/config", async (route) => {
    if (route.request().method() === "PUT") {
      savedConfig = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { config: savedConfig } });
      return;
    }
    await route.fulfill({
      json: {
        config: {
          apiUrl: "https://example.com/api",
          apiKey: "test***",
          model: "test-model",
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "配置" }).click();

  const mode = page.getByLabel("全局危险操作模式");
  const apiKey = page.getByLabel("API Key *");
  await expect(apiKey).toBeEditable();
  await expect(apiKey).toHaveAttribute("type", "password");
  await apiKey.fill("new-api-key");
  await expect(mode).toHaveValue("allow");
  await mode.selectOption("ask");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByText("配置已保存")).toBeVisible();
  expect(savedConfig).toMatchObject({
    apiKey: "new-api-key",
    security: { mode: "ask" },
  });
});

test("shows config save errors", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/config", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 400, json: { error: "invalid config" } });
      return;
    }
    await route.fulfill({
      json: {
        config: {
          apiUrl: "https://example.com/api",
          apiKey: "test***",
          model: "test-model",
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "配置" }).click();
  await page.getByLabel("全局危险操作模式").selectOption("deny");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByText("invalid config")).toBeVisible();
});

test("edits list and JSON configuration", async ({ page }) => {
  let savedConfig: Record<string, unknown> | undefined;
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/config", async (route) => {
    if (route.request().method() === "PUT") {
      savedConfig = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { config: savedConfig } });
      return;
    }
    await route.fulfill({
      json: {
        config: {
          apiUrl: "https://example.com/api",
          apiKey: "",
          model: "test-model",
          enabledPlugins: [],
          plugins: {},
          security: { mode: "allow", tools: {} },
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "配置" }).click();
  await page.getByLabel("启用的内置插件").fill("feishu\ncustom");
  await page.getByLabel("插件私有配置").fill('{"feishu":{"appId":"cli_test","appSecret":"secret"}}');
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByText(/配置已保存/)).toBeVisible();
  expect(savedConfig).toMatchObject({
    enabledPlugins: ["feishu", "custom"],
    plugins: { feishu: { appId: "cli_test", appSecret: "secret" } },
  });
});
