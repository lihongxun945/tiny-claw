import { test, expect } from "@playwright/test";

test("creates and restores a project session as soon as a directory is selected", async ({ page }) => {
  const sessions: Array<Record<string, unknown>> = [];
  await page.addInitScript(() => {
    window.tinyClawDesktop = {
      selectProjectDirectory: async () => "/Users/test/tiny-claw",
    };
  });
  await page.route("**/projects/inspect", async (route) => {
    await route.fulfill({ json: { project: {
      root: "/Users/test/tiny-claw",
      name: "tiny-claw",
      stack: ["Node.js / npm"],
      rules: "(无)",
    } } });
  });
  await page.route("**/projects/status", async (route) => {
    await route.fulfill({ json: { status: { isRepository: true, branch: "main", clean: false, changedCount: 1, files: [{ path: "src/app.ts", indexStatus: " ", workTreeStatus: "M", staged: false, unstaged: true, untracked: false }] } } });
  });
  await page.route("**/projects/diff", async (route) => {
    await route.fulfill({ json: { diff: { path: "src/app.ts", staged: "", unstaged: "diff --git a/src/app.ts b/src/app.ts", truncated: false } } });
  });
  await page.route(/\/sessions$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const session = {
      id: "project-session-1",
      lastActivity: Date.now(),
      preview: "",
      context: { mode: "project", project: { root: "/Users/test/tiny-claw", name: "tiny-claw" } },
    };
    sessions.push(session);
    await route.fulfill({ json: { session } });
  });
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "项目" }).click();
  const selectDirectory = page.getByRole("button", { name: "选择目录" });
  await selectDirectory.hover();
  await expect(selectDirectory).toHaveCSS("background-color", "rgb(240, 238, 255)");
  await expect(selectDirectory).toHaveCSS("color", "rgb(70, 60, 207)");
  await selectDirectory.click();

  await expect(page.locator(".project-group-title")).toHaveText("tiny-claw");
  await expect(page.locator(".project-conversation-item .session-id")).toHaveText("新对话");
  await expect(page.locator(".project-toolbar-path")).toHaveText("/Users/test/tiny-claw");
  await expect(page.locator(".project-toolbar-meta")).toContainText("main · 1 个变更");
  await page.getByRole("button", { name: "变更 1" }).click();
  await page.getByRole("button", { name: /src\/app\.ts/ }).click();
  await expect(page.locator(".project-diff-view")).toContainText("diff --git");

  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();

  await expect(page.locator(".project-group-title")).toHaveText("tiny-claw");
  await expect(page.locator(".session-item.active")).toHaveCount(1);
  await expect(page.locator(".project-toolbar-path")).toHaveText("/Users/test/tiny-claw");
});

test("prevents duplicate project sessions while a project is opening", async ({ page }) => {
  let createCount = 0;
  await page.addInitScript(() => {
    window.tinyClawDesktop = { selectProjectDirectory: async () => "/Users/test/large-project" };
  });
  await page.route("**/projects/inspect", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ json: { project: { root: "/Users/test/large-project", name: "large-project", stack: [], rules: "(无)" } } });
  });
  await page.route("**/projects/status", async (route) => {
    await route.fulfill({ json: { status: { isRepository: false, branch: "", clean: true, changedCount: 0, files: [] } } });
  });
  await page.route(/\/sessions$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createCount += 1;
    await route.fulfill({ json: { session: { id: "only-project-session", context: { mode: "project", project: { root: "/Users/test/large-project", name: "large-project" } } } } });
  });
  await page.route("**/history/sessions", async (route) => route.fulfill({ json: { sessions: [] } }));

  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  const button = page.getByRole("button", { name: "选择目录" });
  await button.dblclick();
  await expect(page.locator(".project-picker-select-btn")).toBeDisabled();
  await expect.poll(() => createCount).toBe(1);
});

test("groups conversations under projects and exposes separate project actions", async ({ page }) => {
  const sessions = [{
    id: "persisted-project-session",
    lastActivity: Date.now(),
    preview: "继续开发项目",
    context: { mode: "project", project: { root: "/Users/test/tiny-claw", name: "tiny-claw" } },
  }, {
    id: "other-project-session",
    lastActivity: Date.now() - 1,
    preview: "检查另一个项目",
    context: { mode: "project", project: { root: "/Users/test/other-app", name: "other-app" } },
  }];
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions } });
  });
  await page.route("**/history/sessions/*/messages", async (route) => {
    await route.fulfill({ json: { messages: [] } });
  });
  await page.route("**/projects/inspect", async (route) => {
    await route.fulfill({ json: { project: {
      root: "/Users/test/tiny-claw",
      name: "tiny-claw",
      stack: ["Node.js / npm"],
      rules: "(无)",
    } } });
  });
  let createdForRoot = "";
  await page.route(/\/sessions$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { projectRoot: string };
    createdForRoot = body.projectRoot;
    const session = {
      id: "new-project-conversation",
      lastActivity: Date.now() + 1,
      preview: "",
      context: { mode: "project", project: { root: body.projectRoot, name: "tiny-claw" } },
    };
    sessions.unshift(session);
    await route.fulfill({ json: { session } });
  });
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();

  await expect(page.locator(".project-group-title")).toHaveText(["tiny-claw", "other-app"]);
  await expect(page.locator(".project-conversation-item .session-id")).toHaveText(["继续开发项目", "检查另一个项目"]);
  await expect.poll(async () => (
    await page.locator(".project-conversation-item").allTextContents()
  ).every((text) => !text.includes("tiny-claw"))).toBe(true);
  await expect(page.locator(".session-item.active")).toHaveCount(1);
  await expect(page.locator(".project-toolbar-path")).toHaveText("/Users/test/tiny-claw");

  await page.getByRole("button", { name: "在 tiny-claw 中新建对话" }).click();
  await expect.poll(() => createdForRoot).toBe("/Users/test/tiny-claw");
  await expect(page.locator(".project-group").first().locator(".project-conversation-item")).toHaveCount(2);
  await expect(page.locator(".project-group").first().locator(".project-conversation-item").first()).toContainText("新对话");

  await page.getByRole("button", { name: "新建项目" }).click();
  await expect(page.getByRole("heading", { name: "项目开发模式" })).toBeVisible();
});

test("deletes a project by removing its sessions without touching the local directory", async ({ page }) => {
  const projectRoot = "/Users/test/tiny-claw";
  const sessions = [{
    id: "project-session-a",
    lastActivity: Date.now(),
    preview: "第一条对话",
    context: { mode: "project", project: { root: projectRoot, name: "tiny-claw" } },
  }, {
    id: "project-session-b",
    lastActivity: Date.now() - 1,
    preview: "第二条对话",
    context: { mode: "project", project: { root: projectRoot, name: "tiny-claw" } },
  }];
  const deletedUrls: string[] = [];

  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions } });
  });
  await page.route("**/history/sessions/*/messages", async (route) => {
    await route.fulfill({ json: { messages: [] } });
  });
  await page.route("**/projects/inspect", async (route) => {
    await route.fulfill({ json: { project: { root: projectRoot, name: "tiny-claw", stack: [], rules: "(无)" } } });
  });
  await page.route("**/projects/status", async (route) => {
    await route.fulfill({ json: { status: { isRepository: false, branch: "", clean: true, changedCount: 0, files: [] } } });
  });
  await page.route("**/sessions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletedUrls.push(route.request().url());
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const index = sessions.findIndex((session) => session.id === id);
    if (index >= 0) sessions.splice(index, 1);
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.locator(".project-conversation-item")).toHaveCount(2);

  page.once("dialog", async (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "删除项目 tiny-claw" }).click();
  await expect.poll(() => deletedUrls.length).toBe(0);
  await expect(page.locator(".project-conversation-item")).toHaveCount(2);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("本地目录和文件不会被删除");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "删除项目 tiny-claw" }).click();

  await expect.poll(() => deletedUrls.length).toBe(2);
  expect(deletedUrls.every((url) => !url.includes(encodeURIComponent(projectRoot)) && !url.includes(projectRoot))).toBe(true);
  await expect(page.locator(".project-group")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "项目开发模式" })).toBeVisible();
});

test("keeps the project list visible while navigating utility views", async ({ page }) => {
  const projectRoot = "/Users/test/tiny-claw";
  await page.route("**/history/sessions", async (route) => {
    await route.fulfill({ json: { sessions: [{
      id: "project-navigation-session",
      lastActivity: Date.now(),
      preview: "项目会话",
      context: { mode: "project", project: { root: projectRoot, name: "tiny-claw" } },
    }, {
      id: "chat-navigation-session",
      lastActivity: Date.now() - 1,
      preview: "普通会话",
      context: { mode: "chat" },
    }] } });
  });
  await page.route("**/history/sessions/*/messages", async (route) => {
    await route.fulfill({ json: { messages: [] } });
  });
  await page.route("**/projects/inspect", async (route) => {
    await route.fulfill({ json: { project: { root: projectRoot, name: "tiny-claw", stack: [], rules: "(无)" } } });
  });
  await page.route("**/projects/status", async (route) => {
    await route.fulfill({ json: { status: { isRepository: false, branch: "", clean: true, changedCount: 0, files: [] } } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.locator(".project-group-title")).toHaveText("tiny-claw");
  await expect(page.locator(".sidebar-primary-action")).toContainText("新建项目");

  for (const name of ["记忆", "日志", "配置"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".project-group-title")).toHaveText("tiny-claw");
    await expect(page.locator(".project-conversation-item")).toContainText("项目会话");
    await expect(page.locator(".sidebar-primary-action")).toContainText("新建项目");
    await expect(page.locator(".session-preview", { hasText: "普通会话" })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.locator(".session-preview", { hasText: "普通会话" })).toBeVisible();
  await expect(page.locator(".project-group-title")).toHaveCount(0);
});
