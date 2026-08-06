import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { applySessionConfig } from "../../src/project.js";
import { createGitDiffTool, createGitStatusTool } from "../../src/tools/project-git.js";
import { createProjectSearchTool } from "../../src/tools/project-search.js";
import { createProjectTreeTool } from "../../src/tools/project-tree.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionContext } from "../../src/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";

describe("project development tools", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  function setup(projectConfig: Record<string, unknown> = {}) {
    const workspace = createTempWorkspace({
      security: { mode: "allow", tools: {} },
      project: {
        security: { mode: "allow", tools: {} },
        treeMaxDepth: 4,
        treeMaxEntries: 10,
        searchMaxResults: 20,
        searchMaxChars: 5000,
        searchTimeoutMs: 5000,
        gitTimeoutMs: 5000,
        diffMaxChars: 5000,
        ...projectConfig,
      },
    });
    paths.push(workspace);
    const root = mkdtempSync(resolve(tmpdir(), "tiny-claw-project-tools-"));
    paths.push(root);
    const sessionContext = { mode: "project" as const, project: { root, name: "project" } };
    const config = applySessionConfig(loadConfig(workspace), sessionContext);
    const context: ToolExecutionContext = { rootPath: root, restrictToRoot: true, sessionContext, config, sessionId: "project-test" };
    return { workspace, root, context, getConfig: () => loadConfig(workspace) };
  }

  it("returns a bounded tree and skips dependency and repository directories", async () => {
    const { workspace, root, context, getConfig } = setup();
    mkdirSync(resolve(root, "src", "nested"), { recursive: true });
    mkdirSync(resolve(root, "node_modules", "ignored"), { recursive: true });
    mkdirSync(resolve(root, ".git"), { recursive: true });
    for (let index = 0; index < 12; index++) writeFileSync(resolve(root, "src", `file-${index}.ts`), "", "utf-8");
    writeFileSync(resolve(root, "node_modules", "ignored", "index.js"), "", "utf-8");

    const result = JSON.parse(await createProjectTreeTool(workspace, getConfig).execute({}, context));
    expect(result).toMatchObject({ truncated: true, depth: 4 });
    expect(result.entries).toHaveLength(10);
    expect(result.entries.some((entry: { path: string }) => entry.path.includes("node_modules") || entry.path.includes(".git"))).toBe(false);
  });

  it("searches text and file globs with structured bounded results", async () => {
    const { workspace, root, context, getConfig } = setup();
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src", "alpha.ts"), "const marker = 'needle';\n", "utf-8");
    writeFileSync(resolve(root, "src", "beta.js"), "const marker = 'needle';\n", "utf-8");
    const tool = createProjectSearchTool(workspace, getConfig);

    const textResult = JSON.parse(await tool.execute({ query: "needle", mode: "text", glob: "**/*.ts" }, context));
    expect(textResult).toEqual({
      results: [expect.objectContaining({ path: "src/alpha.ts", line: 1, text: expect.stringContaining("needle") })],
      truncated: false,
    });
    const filesResult = JSON.parse(await tool.execute({ query: "**/*.ts", mode: "files" }, context));
    expect(filesResult.results).toEqual([{ path: "src/alpha.ts" }]);
  });

  it("rejects paths outside the project root", async () => {
    const { workspace, context, getConfig } = setup();
    const result = JSON.parse(await createProjectTreeTool(workspace, getConfig).execute({ path: "../" }, context));
    expect(result.error).toContain("之外");
  });

  it("reuses asynchronous git status and diff implementations", async () => {
    const { workspace, root, context, getConfig } = setup();
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    writeFileSync(resolve(root, "tracked.txt"), "before\n", "utf-8");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
    writeFileSync(resolve(root, "tracked.txt"), "after\n", "utf-8");

    const status = JSON.parse(await createGitStatusTool(workspace, getConfig).execute({}, context));
    expect(status).toMatchObject({ isRepository: true, clean: false, changedCount: 1 });
    const diff = JSON.parse(await createGitDiffTool(workspace, getConfig).execute({}, context));
    expect(diff).toMatchObject({ path: ".", unstaged: expect.stringContaining("tracked.txt") });
  });

  it("filters project-only tool definitions from chat sessions", () => {
    const registry = new ToolRegistry();
    registry.register(createProjectTreeTool("/tmp", () => ({}) as never));
    expect(registry.getDefinitions({ mode: "chat" })).toEqual([]);
    expect(registry.getDefinitions({ mode: "project", project: { root: "/tmp", name: "tmp" } })).toEqual([
      expect.objectContaining({ name: "project_tree" }),
    ]);
  });
});
