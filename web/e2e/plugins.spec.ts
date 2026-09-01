import { expect, test } from "@playwright/test";

test("shows plugin status, permissions and saves declared config", async ({ page }) => {
  let saved: Record<string, unknown> | undefined;
  const plugin = {
    id: "demo",
    version: "1.2.0",
    kind: "workspace",
    state: "active",
    enabled: true,
    canToggle: true,
    description: "Demo plugin",
    requires: { base: "^1.0.0" },
    optional: {},
    config: { valid: true, issues: [] },
    permissions: {
      declared: { tools: ["demo_tool"], network: { hosts: ["api.example.com"] } },
      issues: [],
    },
  };
  const schema = {
    fields: {
      endpoint: { type: "string", title: "服务地址", required: true },
      token: { type: "string", title: "访问令牌", required: true, secret: true },
    },
  };

  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route(/\/plugins$/, async (route) => route.fulfill({ json: { plugins: [plugin] } }));
  await page.route("**/plugins/demo/config", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { pluginId: "demo", schema, config: saved, valid: true, issues: [], plugin } });
      return;
    }
    await route.fulfill({ json: { pluginId: "demo", schema, config: { endpoint: "https://old.example", token: "secr***" }, valid: true, issues: [] } });
  });
  await page.route("**/plugins/demo/state", async (route) => {
    const { enabled } = route.request().postDataJSON() as { enabled: boolean };
    plugin.enabled = enabled;
    plugin.state = enabled ? "active" : "stopped";
    await route.fulfill({ json: { plugin } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "插件" }).click();
  await expect(page.getByRole("heading", { name: "demo" })).toBeVisible();
  await expect(page.getByText("工具：demo_tool")).toBeVisible();
  await expect(page.getByText("网络：api.example.com")).toBeVisible();
  await expect(page.getByText("base ^1.0.0")).toBeVisible();
  await page.getByLabel("启用插件").uncheck();
  await expect(page.getByText("插件已禁用。")).toBeVisible();
  await page.getByLabel("服务地址 *").fill("https://new.example");
  await page.getByRole("button", { name: "保存并重载" }).click();

  await expect(page.getByText("插件配置已保存并完成重载。")).toBeVisible();
  expect(saved).toEqual({ endpoint: "https://new.example", token: "secr***" });
});
