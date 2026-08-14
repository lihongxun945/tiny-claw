import { expect, test } from "@playwright/test";

test("shows a retry action when local model status cannot be loaded", async ({ page }) => {
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/local-models", async (route) => route.fulfill({ status: 502, json: { error: "模型服务暂时不可用" } }));
  await page.route("**/config", async (route) => route.fulfill({ json: { config: {
    remoteModel: { enabled: true },
    localModel: { enabled: false, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    apiUrl: "https://example.com/api", apiKey: "test***", model: "test-model",
  } } }));

  await page.goto("/");
  await page.getByRole("button", { name: "配置" }).click();
  await expect(page.getByText("模型状态加载失败")).toBeVisible();
  await expect(page.getByText("模型服务暂时不可用")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
  await expect(page.getByText("正在读取模型状态...")).toHaveCount(0);
});

test("configures and tests remote, Qwen, and Gemma local models", async ({ page }) => {
  const testedTargets: string[] = [];
  let downloadRequests = 0;
  let localState: "idle" | "downloading" | "ready" = "idle";
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/local-models**", async (route) => {
    if (route.request().url().endsWith("/download")) {
      downloadRequests += 1;
      localState = "downloading";
      await route.fulfill({ status: 202, json: { accepted: true } });
      return;
    }
    const downloading = localState === "downloading";
    const ready = localState === "ready";
    await route.fulfill({ json: { models: [
      { id: "qwen3.5-0.8b-q4", name: "Qwen3.5 0.8B Q4", description: "轻量", size: "约 563 MB", family: "Qwen", license: "Apache-2.0", recommendedMemoryGb: 8, recommendedContextTokens: 32768, maxContextTokens: 131072, installed: ready, status: localState, progress: downloading ? 0.63 : ready ? 1 : 0, downloadedBytes: downloading ? 354658470 : ready ? 590348288 : 0, totalBytes: downloading || ready ? 590348288 : 0 },
      { id: "qwen3.5-4b-q4", name: "Qwen3.5 4B Q4", description: "推荐", size: "约 2.58 GB", family: "Qwen", license: "Apache-2.0", recommendedMemoryGb: 16, recommendedContextTokens: 32768, maxContextTokens: 131072, installed: false, status: "idle", progress: 0, downloadedBytes: 0, totalBytes: 0 },
      { id: "gemma-4-e2b-it-q4", name: "Gemma 4 E2B IT Q4", description: "轻量通用", size: "约 2.84 GB", family: "Gemma", license: "Apache-2.0", recommendedMemoryGb: 8, recommendedContextTokens: 32768, maxContextTokens: 131072, installed: false, status: "idle", progress: 0, downloadedBytes: 0, totalBytes: 0 },
      { id: "gemma-4-e4b-it-q4", name: "Gemma 4 E4B IT Q4", description: "通用对话", size: "约 4.59 GB", family: "Gemma", license: "Apache-2.0", recommendedMemoryGb: 16, recommendedContextTokens: 32768, maxContextTokens: 131072, installed: false, status: "idle", progress: 0, downloadedBytes: 0, totalBytes: 0 },
    ] } });
  });
  await page.route("**/models/test", async (route) => {
    testedTargets.push((route.request().postDataJSON() as { target: string }).target);
    await route.fulfill({ json: { ok: true, elapsedMs: 12, text: "OK" } });
  });
  await page.route("**/config", async (route) => route.fulfill({ json: { config: {
    remoteModel: { enabled: true },
    localModel: { enabled: false, modelId: "qwen3.5-4b-q4", contextSize: 32768 },
    apiUrl: "https://example.com/api", apiKey: "test***", model: "test-model",
  } } }));

  await page.goto("/");
  await page.getByRole("button", { name: "配置" }).click();
  await expect(page.getByRole("switch", { name: "启用远程模型" })).toBeChecked();
  await expect(page.getByRole("heading", { name: "远程模型" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本地模型" })).toBeVisible();
  await page.getByRole("switch", { name: "启用本地模型" }).check();
  await page.getByLabel("本地模型", { exact: true }).selectOption("qwen3.5-0.8b-q4");
  await expect(page.getByLabel("本地上下文 Token")).toHaveValue("32768");
  await expect(page.getByText("建议至少 8 GB 内存；推荐上下文 32,768，模型上限 131,072 tokens")).toBeVisible();
  await expect(page.getByLabel("本地模型", { exact: true }).locator("option")).toHaveCount(4);
  await expect(page.getByText(/选择模型不会自动下载/)).toBeVisible();
  expect(downloadRequests).toBe(0);
  await page.getByRole("button", { name: "下载并安装" }).click();
  await expect(page.getByLabel("模型下载进度")).toHaveAttribute("value", "0.63", { timeout: 5000 });
  await expect(page.getByText("63%", { exact: true })).toBeVisible();
  await expect(page.getByText(/338 MB \/ 563 MB/)).toBeVisible();
  expect(downloadRequests).toBe(1);
  localState = "ready";
  await expect(page.getByRole("button", { name: "测试模型" })).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.getByRole("button", { name: "测试模型" }).click();
  expect(testedTargets).toEqual(["remote", "local"]);
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
  await page.getByRole("textbox", { name: /^API Key/ }).fill("new-api-key");
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
